"""Major roads that flood, per flood layer and per scenario.

Outputs:
  docs/data/roads/<layer>.geojson  flooded pieces of major roads for each of the 10 flood layers
  docs/data/roads_summary.json     per scenario key (b{bay}_r{fema}_c{low}): total km and the most-flooded roads

Bridges, viaducts and tunnels are skipped: land flooding does not model them, and the water goes under.
Length is measured on the flooded pieces in EPSG:3310 meters.
"""
import json
from collections import defaultdict

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import LineString

from common import CRS, DOCS as OUT, FLOOD, LAYERS, RAW, county_land, scenario_keys, scenario_layers
CLASS = {"motorway": "fwy", "trunk": "fwy", "primary": "art", "secondary": "art", "tertiary": "col"}
MIN_PIECE_M = 15
SIMPLIFY_M = 4


def label(tags):
    cls = tags["highway"].replace("_link", "")
    ref = (tags.get("ref") or "").split(";")[0].strip()
    if cls in ("motorway", "trunk") and ref:
        return ref
    return tags.get("name") or ref


def load_roads():
    rows = []
    for e in json.load(open(RAW / "osm" / "roads.json"))["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or len(e.get("geometry", [])) < 2:
            continue
        if t.get("bridge") not in (None, "no") or t.get("tunnel") not in (None, "no"):
            continue
        name = label(t)
        if not name:
            continue
        rows.append((name, CLASS[t["highway"].replace("_link", "")],
                     LineString([(p["lon"], p["lat"]) for p in e["geometry"]])))
    g = gpd.GeoDataFrame(rows, columns=["n", "h", "geometry"], crs=4326).to_crs(CRS)
    land = county_land()
    shapely.prepare(land)
    return g[shapely.intersects(land, g.geometry.values)].reset_index(drop=True)


def main():
    roads = load_roads()
    print(f"{len(roads)} at-grade major road segments")
    geoms = roads.geometry.values
    pieces = {}  # layer -> {way index: geometry}
    for layer in LAYERS:
        poly = gpd.read_file(FLOOD, layer=layer).geometry.iloc[0]
        shapely.prepare(poly)
        cand = np.flatnonzero(shapely.intersects(poly, geoms))
        cut = shapely.intersection(geoms[cand], poly)
        pieces[layer] = {int(i): c for i, c in zip(cand, cut) if shapely.length(c) >= MIN_PIECE_M}

        lines = []
        for i, c in pieces[layer].items():
            for part in getattr(c, "geoms", [c]):
                if part.geom_type == "LineString" and part.length >= MIN_PIECE_M:
                    lines.append((roads.n[i], roads.h[i], part))
        gdf = gpd.GeoDataFrame(lines, columns=["n", "h", "geometry"], crs=CRS)
        gdf["geometry"] = gdf.geometry.simplify(SIMPLIFY_M)
        path = OUT / "roads" / f"{layer}.geojson"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        gdf.to_crs(4326).to_file(path, driver="GeoJSON", COORDINATE_PRECISION=5)
        print(f"  {layer:<11}{len(gdf):>5} pieces  {sum(shapely.length(c) for c in pieces[layer].values()) / 1000:>6.1f} km  {path.stat().st_size / 1e3:>6.0f} KB")

    summary = {}
    for key in scenario_keys():
        by_way = defaultdict(list)
        for layer in scenario_layers(key):
            for i, geom in pieces[layer].items():
                by_way[i].append(geom)
        km = defaultdict(float)
        for i, parts in by_way.items():
            km[roads.n[i]] += shapely.length(shapely.union_all(parts)) / 1000
        top = sorted(km.items(), key=lambda kv: -kv[1])[:8]
        summary[key] = {"km": round(sum(km.values()), 1), "top": [[n, round(v, 1)] for n, v in top if v >= 0.05]}
    (OUT / "roads_summary.json").write_text(json.dumps(summary, separators=(",", ":"), ensure_ascii=False))
    for k in ("b1_r0_c0", "b2_r0_c0", "b2.5_r0_c0", "b3_r0_c0", "b4_r0_c1", "b0_r100_c0", "b0_r500_c0"):
        print(k, summary[k]["km"], "km;", summary[k]["top"][:4])


if __name__ == "__main__":
    main()
