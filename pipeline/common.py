"""Paths, flood-layer names, and helpers shared by the pipeline scripts."""
import json
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"      # downloads (gitignored)
WORK = ROOT / "data" / "work"    # intermediates (gitignored)
DOCS = ROOT / "docs" / "data"    # published with the site
FLOOD = WORK / "flood_full.gpkg"
CRS = 3310                       # California Albers, meters
HEADERS = {"User-Agent": "alameda-flood-map/0.1 (research dashboard)"}
COUNTY_BBOX = "37.44,-122.38,37.93,-121.45"  # south, west, north, east (Overpass order)

BAY_LEVELS = [0, 1, 2, 2.5, 3, 4]  # feet above normal high tide (MHHW); 0 = no Bay flooding

# Flood layers in bitmask order: bits 0-3 Bay +1..+4 ft, 4-7 low-lying +1..+4 ft, 8 FEMA 100-yr, 9 FEMA 500-yr,
# 10-11 Bay and low-lying +2.5 ft (added later, appended so earlier bit positions stay the same).
LAYERS = ([f"bay_{i}ft" for i in range(1, 5)] + [f"low_{i}ft" for i in range(1, 5)] + ["fema_100yr", "fema_500yr"]
          + ["bay_2.5ft", "low_2.5ft"])
OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter"]


def scenario_keys():
    """Every scenario key: Bay level x FEMA zone (0, 100, 500) x low-lying areas (0/1)."""
    return [f"b{b:g}_r{r}_c{c}" for b in BAY_LEVELS for r in (0, 100, 500) for c in (0, 1)]


def scenario_layers(key):
    """Flood layers in a scenario key such as 'b2.5_r100_c1' (Bay +2.5 ft, FEMA 100-yr zone, low-lying areas on)."""
    b, r, c = (float(x[1:]) for x in key.split("_"))
    layers = ([f"bay_{b:g}ft"] if b else []) + ([f"low_{b:g}ft"] if b and c else [])
    if r:
        layers.append("fema_100yr" if r == 100 else "fema_500yr")
    return layers


def scenario_mask(key):
    return sum(1 << LAYERS.index(name) for name in scenario_layers(key))


def county_land():
    """Alameda County land area (union of census tracts), EPSG:3310."""
    t = gpd.read_file(f"zip://{RAW / 'census' / 'tracts_ca.zip'}").to_crs(CRS)
    land = t[t.COUNTYFP == "001"].union_all()
    return land if shapely.is_valid(land) else shapely.make_valid(land)


def overpass(query, attempts=8):
    """Run an Overpass API query with retries (mostly on the main server, occasionally a mirror); returns elements."""
    for attempt in range(attempts):
        url = OVERPASS_SERVERS[0 if attempt % 4 else attempt // 4 % len(OVERPASS_SERVERS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=420)
            r.raise_for_status()
            return r.json()["elements"]
        except (requests.RequestException, ValueError) as e:
            print(f"  {url.split('/')[2]} failed ({str(e)[:60]}); retrying", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Overpass query failed")


def block_shapes(bx, by):
    """Populated 2020 blocks (EPSG:3310) in the same order as data/work/block_flood.npz, with pop and hu columns.

    Checks each block's interior point against the stored block location, so a mismatch fails loudly."""
    raw = RAW / "census"
    rows = json.load(open(raw / "block_pop_2020.json"))
    pop = pd.DataFrame(rows[1:], columns=rows[0])
    pop["GEOID20"] = pop.state + pop.county + pop.tract + pop.block
    pop["pop"], pop["hu"] = pop.P1_001N.astype(int), pop.H1_001N.astype(int)
    b = gpd.read_file(f"zip://{raw / 'blocks_alameda.zip'}")[["GEOID20", "geometry"]].to_crs(CRS)
    b = b.merge(pop[["GEOID20", "pop", "hu"]], on="GEOID20", how="left", validate="1:1")
    b = b[(b["pop"] > 0) | (b["hu"] > 0)].reset_index(drop=True)
    pts = b.geometry.representative_point()
    off = np.hypot(pts.x.values - bx, pts.y.values - by)
    assert len(b) == len(bx) and off.max() < 1.0, f"block order mismatch (max offset {off.max():.0f} m)"
    return b


def road_network():
    """OSM drivable roads (data/raw/osm/all_roads.json) as a graph.

    Returns a dict: node lon/lat and x/y (EPSG:3310); edge endpoints a/b, at_grade (False for bridges and tunnels),
    and the road name of each edge."""
    els = json.load(open(RAW / "osm" / "all_roads.json"))["elements"]
    node_id, lon, lat, ea, eb, grade, names = {}, [], [], [], [], [], []
    for e in els:
        g = e.get("geometry") or []
        if len(g) < 2:
            continue
        t = e.get("tags", {})
        at_grade = t.get("bridge") in (None, "no") and t.get("tunnel") in (None, "no")
        name = t.get("name") or t.get("ref") or ""
        prev = None
        for p in g:
            k = (round(p["lon"], 7), round(p["lat"], 7))
            i = node_id.get(k)
            if i is None:
                i = node_id[k] = len(lon)
                lon.append(k[0])
                lat.append(k[1])
            if prev is not None and prev != i:
                ea.append(prev)
                eb.append(i)
                grade.append(at_grade)
                names.append(name)
            prev = i
    pts = gpd.GeoSeries(gpd.points_from_xy(lon, lat), crs=4326).to_crs(CRS)
    return {"lon": np.array(lon), "lat": np.array(lat), "x": pts.x.values, "y": pts.y.values,
            "a": np.array(ea), "b": np.array(eb), "at_grade": np.array(grade), "name": np.array(names, dtype=object)}
