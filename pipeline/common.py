"""Paths, flood-layer names, and helpers shared by the pipeline scripts."""
import time
from pathlib import Path

import geopandas as gpd
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
