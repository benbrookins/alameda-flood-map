"""Critical facilities and shelter sites, each tagged with the flood layers that reach it.

Output: docs/data/points.json (GeoJSON). Properties: id, k kind, n name, c city, m flood bitmask,
and for shelter sites b (bucket: high_school, library, ...).
Mask bits: 0-3 = bay_1..4ft, 4-7 = low_1..4ft, 8 = fema_100yr, 9 = fema_500yr.
A site counts as flooded when the flood layers in the chosen scenario cover its point location.

Pre-identified shelters come from data/raw/shelters/geocoded.csv (made by 07_geocode_shelters.py, which needs
data/work/points_generic.json from a first run of this script). Generic sites within SAME_SITE_M of a
pre-identified shelter are treated as the same place and dropped.
"""
import json

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from common import CRS, DOCS, FLOOD, LAYERS, RAW, ROOT, WORK, county_land

OUT = DOCS / "points.json"
PRE_FILE = RAW / "shelters" / "geocoded.csv"
OFFICIAL = WORK / "official_facilities.csv"  # from 09_official_facilities.py
SHELTER_KINDS = {"school", "community", "library", "worship"}
SAME_SITE_M = 120

SCHOOL_BUCKET = {
    "High Schools (Public)": "high_school", "K-12 Schools (Public)": "high_school",
    "Intermediate/Middle Schools (Public)": "middle_school", "Elementary Schools (Public)": "elementary_school",
    "Continuation High Schools": "small_school", "Alternative Schools of Choice": "small_school",
    "Special Education Schools (Public)": "small_school",
}
DEFAULT_NAME = {
    "hospital": "Hospital", "care": "Care facility", "dialysis": "Dialysis center", "fire": "Fire station",
    "police": "Police station", "school": "School", "community": "Community center", "library": "Library",
    "worship": "Place of worship",
}


def bucket_from_name(name, kind):
    n = name.lower()
    if kind == "library" or "library" in n:
        return "library"
    if kind == "worship" or any(w in n for w in ("church", "muslim", "tidings", "temple", "mosque")):
        return "worship"
    if any(w in n for w in ("college", "university", "cal state")):
        return "college"
    if "high school" in n:
        return "high_school"
    if "middle" in n:
        return "middle_school"
    if "elementary" in n or "glen school" in n:
        return "elementary_school"
    if "senior" in n or "age well" in n:
        return "senior_center"
    return "community_center"


def osm_points(path, classify):
    rows = []
    for e in json.load(open(path))["elements"]:
        lat, lon = (e["lat"], e["lon"]) if e["type"] == "node" else (e["center"]["lat"], e["center"]["lon"])
        tags = e.get("tags", {})
        kind = classify(tags)
        if kind:
            name = tags.get("name") or DEFAULT_NAME[kind]
            rows.append((kind, name, lon, lat, bucket_from_name(name, kind) if kind in SHELTER_KINDS else None))
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
    s = s[(s.County == "Alameda") & (s.StatusType == "Active") & s.SOCType.isin(SCHOOL_BUCKET) & (s.School != "No Data")]
    s = s.dropna(subset=["Latitude", "Longitude"])
    return [("school", r.School, float(r.Longitude), float(r.Latitude), SCHOOL_BUCKET[r.SOCType]) for r in s.itertuples()]


def pre_identified():
    if not PRE_FILE.exists():
        return []
    rows = pd.read_csv(PRE_FILE).dropna(subset=["lat", "lon"])
    return [("pre", r.name, float(r.lon), float(r.lat), bucket_from_name(r.name, "pre")) for r in rows.itertuples()]


def projected(rows):
    df = pd.DataFrame(rows, columns=["k", "n", "lon", "lat", "b"])
    g = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df.lon, df.lat), crs=4326).to_crs(CRS)
    g["x"], g["y"] = g.geometry.x, g.geometry.y
    return g


def city_of(g):
    tr = gpd.read_file(DOCS / "tracts.geojson")[["place", "geometry"]].to_crs(CRS)
    near = gpd.sjoin_nearest(g[["geometry"]], tr, how="left", max_distance=3000)
    return near["place"].groupby(level=0).first().reindex(g.index).fillna("Unincorporated")


def dedupe(df, tol_m=250):
    keep = []
    for _, g in df.groupby(["k", "n"]):
        taken = []
        for i, x, y in zip(g.index, g.x, g.y):
            if all(np.hypot(x - tx, y - ty) > tol_m for tx, ty in taken):
                taken.append((x, y))
                keep.append(i)
    return df.loc[sorted(keep)]


def main():
    fac = RAW / "osm" / "facilities.json"
    use_osm_fac = not OFFICIAL.exists() and fac.exists()
    if not OFFICIAL.exists():
        print("WARNING: official_facilities.csv missing (run 09_official_facilities.py); using OpenStreetMap facilities.")
    g = projected(osm_points(RAW / "osm" / "amenities.json", classify_amenity)
                  + (osm_points(fac, classify_facility) if use_osm_fac else []) + schools())
    land = county_land().buffer(300)
    shapely.prepare(land)
    g = g[shapely.contains_xy(land, g.x.values, g.y.values)]
    before = len(g)
    g = dedupe(g).reset_index(drop=True)
    print(f"{before} points, {before - len(g)} duplicates removed")
    g["c"] = city_of(g)
    write(g.assign(m=0), ROOT / "data" / "work" / "points_generic.json")

    pre = pre_identified()
    if pre:
        pg = projected(pre)
        near = np.min(np.hypot(g.x.values[:, None] - pg.x.values[None, :], g.y.values[:, None] - pg.y.values[None, :]), axis=1)
        same = g.k.isin(SHELTER_KINDS).values & (near <= SAME_SITE_M)
        print(f"{len(pg)} pre-identified shelters; {int(same.sum())} generic sites merged into them")
        g = gpd.GeoDataFrame(pd.concat([g[~same], pg], ignore_index=True), geometry="geometry", crs=CRS)

    if OFFICIAL.exists():
        of = pd.read_csv(OFFICIAL)
        og = gpd.GeoDataFrame(of.assign(b=None), geometry=gpd.points_from_xy(of.lon, of.lat), crs=4326).to_crs(CRS)
        og["x"], og["y"] = og.geometry.x, og.geometry.y
        g = gpd.GeoDataFrame(pd.concat([g, og], ignore_index=True), geometry="geometry", crs=CRS)
        print(f"{len(og)} hospitals, care facilities, and dialysis clinics from state licensing lists")
    g["c"] = city_of(g)

    mask = np.zeros(len(g), dtype=int)
    for bit, name in enumerate(LAYERS):
        geom = gpd.read_file(FLOOD, layer=name).geometry.iloc[0]
        shapely.prepare(geom)
        mask |= shapely.contains_xy(geom, g.x.values, g.y.values).astype(int) << bit
    g["m"] = mask

    write(g, OUT)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.0f} KB)\n")
    report(g)


def write(g, path):
    out = g.to_crs(4326)
    feats = []
    for r, p in zip(g.itertuples(), out.geometry):
        props = {"id": int(r.Index), "k": r.k, "n": r.n, "m": int(r.m), "c": r.c}
        if isinstance(r.b, str):
            props["b"] = r.b
        if isinstance(getattr(r, "st", None), str):
            props.update(st=r.st, cap=int(r.cap))
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(p.x, 5), round(p.y, 5)]},
                      "properties": props})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"), ensure_ascii=False))


def report(g):
    print(f"{'kind':<11}{'total':>6}{'bay +1':>8}{'bay +3':>8}{'bay +4':>8}{'FEMA100':>9}{'FEMA500':>9}")
    for kind, grp in g.groupby("k"):
        m = grp.m.values
        print(f"{kind:<11}{len(grp):>6}{int(((m & 1) > 0).sum()):>8}{int(((m & 4) > 0).sum()):>8}"
              f"{int(((m & 8) > 0).sum()):>8}{int(((m & 256) > 0).sum()):>9}{int(((m & 512) > 0).sum()):>9}")
    sh = g[g.b.notna()]
    print("\nshelter buckets (all sites / pre-identified):")
    for b, grp in sh.groupby("b"):
        print(f"  {b:<18}{len(grp):>5}{int((grp.k == 'pre').sum()):>6}")


if __name__ == "__main__":
    main()
