"""Critical facilities and potential shelter sites, each tagged with the flood layers that reach it.

Output: docs/data/points.json (GeoJSON). Properties: k kind, n name, m bitmask.
Mask bits: 0-3 = bay_1..4ft, 4-7 = low_1..4ft, 8 = fema_100yr, 9 = fema_500yr.
A site counts as flooded when the flood layers in the chosen scenario cover its point location.
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
FLOOD = ROOT / "data" / "work" / "flood_full.gpkg"
OUT = ROOT / "docs" / "data" / "points.json"
CRS = 3310
LAYERS = [f"bay_{i}ft" for i in range(1, 5)] + [f"low_{i}ft" for i in range(1, 5)] + ["fema_100yr", "fema_500yr"]

SCHOOL_TYPES = {
    "Elementary Schools (Public)", "Intermediate/Middle Schools (Public)", "High Schools (Public)",
    "K-12 Schools (Public)", "Continuation High Schools", "Alternative Schools of Choice",
    "Special Education Schools (Public)",
}
DEFAULT_NAME = {
    "hospital": "Hospital", "care": "Care facility", "dialysis": "Dialysis center", "fire": "Fire station",
    "police": "Police station", "school": "School", "community": "Community center", "library": "Library",
    "worship": "Place of worship",
}


def county_land():
    t = gpd.read_file(f"zip://{RAW / 'census' / 'tracts_ca.zip'}").to_crs(CRS)
    land = t[t.COUNTYFP == "001"].union_all()
    return land if shapely.is_valid(land) else shapely.make_valid(land)


def osm_points(path, classify):
    rows = []
    for e in json.load(open(path))["elements"]:
        lat, lon = (e["lat"], e["lon"]) if e["type"] == "node" else (e["center"]["lat"], e["center"]["lon"])
        tags = e.get("tags", {})
        kind = classify(tags)
        if kind:
            rows.append((kind, tags.get("name") or DEFAULT_NAME[kind], lon, lat))
    return rows


def classify_amenity(t):
    return {"fire_station": "fire", "police": "police", "community_centre": "community",
            "library": "library", "place_of_worship": "worship"}.get(t.get("amenity"))


def classify_facility(t):
    if t.get("amenity") == "hospital":
        return "hospital"
    if t.get("amenity") == "nursing_home" or t.get("social_facility") in {"nursing_home", "assisted_living", "group_home"}:
        return "care"
    if t.get("healthcare") == "dialysis":
        return "dialysis"
    return None


def schools():
    s = pd.read_csv(RAW / "schools" / "pubschls.txt", sep="\t", dtype=str, encoding="latin1")
    s = s[(s.County == "Alameda") & (s.StatusType == "Active") & s.SOCType.isin(SCHOOL_TYPES) & (s.School != "No Data")]
    s = s.dropna(subset=["Latitude", "Longitude"])
    return [("school", r.School, float(r.Longitude), float(r.Latitude)) for r in s.itertuples()]


def dedupe(df, tol_m=250):
    keep = []
    for (kind, name), g in df.groupby(["k", "n"]):
        taken = []
        for i, x, y in zip(g.index, g.x, g.y):
            if all(np.hypot(x - tx, y - ty) > tol_m for tx, ty in taken):
                taken.append((x, y))
                keep.append(i)
    return df.loc[sorted(keep)]


def main():
    fac = RAW / "osm" / "facilities.json"
    if not fac.exists():
        print("WARNING: facilities.json missing; run 01_download.py osm_facilities. Hospitals and care homes skipped.")
    rows = (osm_points(RAW / "osm" / "amenities.json", classify_amenity)
            + (osm_points(fac, classify_facility) if fac.exists() else []) + schools())
    df = pd.DataFrame(rows, columns=["k", "n", "lon", "lat"])
    g = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df.lon, df.lat), crs=4326).to_crs(CRS)
    g["x"], g["y"] = g.geometry.x, g.geometry.y
    land = county_land().buffer(300)
    shapely.prepare(land)
    g = g[shapely.contains_xy(land, g.x.values, g.y.values)]
    before = len(g)
    g = dedupe(g).reset_index(drop=True)
    print(f"{before} points, {before - len(g)} duplicates removed")

    mask = np.zeros(len(g), dtype=int)
    for bit, name in enumerate(LAYERS):
        geom = gpd.read_file(FLOOD, layer=name).geometry.iloc[0]
        shapely.prepare(geom)
        inside = shapely.contains_xy(geom, g.x.values, g.y.values)
        mask |= inside.astype(int) << bit
    g["m"] = mask

    out = g.to_crs(4326)
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(p.x, 5), round(p.y, 5)]},
              "properties": {"k": r.k, "n": r.n, "m": int(r.m)}} for r, p in zip(g.itertuples(), out.geometry)]
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.0f} KB)\n")

    print(f"{'kind':<11}{'total':>6}{'bay +1':>8}{'bay +3':>8}{'bay +4':>8}{'FEMA100':>9}{'FEMA500':>9}")
    for kind, grp in g.groupby("k"):
        m = grp.m.values
        print(f"{kind:<11}{len(grp):>6}{int(((m & 1) > 0).sum()):>8}{int(((m & 4) > 0).sum()):>8}"
              f"{int(((m & 8) > 0).sum()):>8}{int(((m & 256) > 0).sum()):>9}{int(((m & 512) > 0).sum()):>9}")


if __name__ == "__main__":
    main()
