"""Estimate the size of each shelter site from OpenStreetMap building footprints.

For each shelter site (points.json features with a bucket `b`):
  1. Find the site's own outline: the smallest OSM campus/site area of the matching type that contains the
     point (or lies within NEAR_M of it). Buildings whose center is inside that outline belong to the site.
  2. Without an outline, use the building containing the point, else the nearest building within NEAR_M.
  3. Main building = the largest building tagged or named as a gym/multipurpose hall (if it is a real hall:
     at least GYM_MIN_SQFT or 40% of the largest building), else the largest building.
  4. Sanity flags: sizes more than 3x or under 1/4 of the median for the site's type, and nearest-building matches
     for schools and colleges, are marked unknown. Footprints often catch a host building (a library in a mall)
     or miss the gym, so they are used only to say whether a site is larger, typical, or smaller for its type.

Downloads are cached in data/raw/osm/. Run after 04_points.py (site ids come from points.json).
Outputs: docs/data/site_size.json {id: [main_building_sqft, rel]} with rel L larger / T typical / S smaller
         than typical for the type (middle half), or ? unknown
         data/work/site_size_review.csv for spot checks.
"""
import json
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "osm"
DOCS = ROOT / "docs" / "data"
CRS = 3310
SQFT = 10.7639
NEAR_M = 60
GYM_MIN_SQFT = 5000
CAMPUS_BUCKETS = {"college", "high_school", "middle_school", "elementary_school", "small_school"}
HEADERS = {"User-Agent": "alameda-flood-map/0.1 (research dashboard)"}
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
BBOX = "37.44,-122.38,37.93,-121.45"
SITE_TYPES = {
    "college": {"college", "university"}, "high_school": {"school"}, "middle_school": {"school"},
    "elementary_school": {"school"}, "small_school": {"school"}, "community_center": {"community_centre"},
    "senior_center": {"community_centre", "social_facility"}, "library": {"library"}, "worship": {"place_of_worship"},
}
GYM_WORDS = ("gym", "multipurpose", "multi-purpose", "mpr", "pavilion", "field house", "fieldhouse", "sports")


def overpass(query):
    for attempt in range(8):
        try:
            r = requests.post(SERVERS[0 if attempt % 4 else attempt // 4 % 2], data={"data": query}, headers=HEADERS, timeout=400)
            r.raise_for_status()
            return r.json()["elements"]
        except (requests.RequestException, ValueError) as e:
            print(f"  overpass retry ({str(e)[:50]})", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Overpass failed")


def cached(path, fetch):
    if not path.exists():
        path.write_text(json.dumps(fetch()))
    return json.loads(path.read_text())


def way_polygon(geom):
    pts = [(p["lon"], p["lat"]) for p in geom]
    return Polygon(pts) if len(pts) >= 4 and pts[0] == pts[-1] else None


def campuses():
    els = cached(RAW / "site_outlines.json", lambda: overpass(
        f'[out:json][timeout:300][bbox:{BBOX}];'
        '(way["amenity"~"^(school|college|university|community_centre|library|place_of_worship|social_facility)$"];'
        'relation["amenity"~"^(school|college|university|community_centre|library|place_of_worship)$"]["type"="multipolygon"];);'
        'out geom tags;'))
    rows = []
    for e in els:
        if e["type"] == "way":
            poly = way_polygon(e.get("geometry", []))
        else:
            lines = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]]) for m in e.get("members", [])
                     if m.get("role") == "outer" and len(m.get("geometry", [])) >= 2]
            parts = list(polygonize(unary_union(lines))) if lines else []
            poly = unary_union(parts) if parts else None
        if poly is not None and poly.is_valid and poly.area > 0:
            rows.append((e["tags"]["amenity"], poly))
    g = gpd.GeoDataFrame(rows, columns=["amenity", "geometry"], crs=4326).to_crs(CRS)
    g["area"] = g.area
    return g


def fetch_buildings(sites, batch=120):
    els = []
    for i in range(0, len(sites), batch):
        part = sites.iloc[i:i + batch]
        clauses = "".join(f'way["building"](around:{600 if b == "college" else 250},{lat:.6f},{lon:.6f});'
                          for b, lat, lon in zip(part.b, part.lat, part.lon))
        got = overpass(f"[out:json][timeout:300];({clauses});out geom tags;")
        els += got
        print(f"  buildings batch {i // batch + 1}: {len(got)}", flush=True)
        time.sleep(2)
    return els


def buildings(sites):
    path = RAW / "site_buildings.json"
    els = json.loads(path.read_text()) if path.exists() else []
    if els:
        # sites added since the cache was made (no cached building within 150 m) get their own fetch
        cached_pts = np.array([(p["lon"], p["lat"]) for e in els for p in e.get("geometry", [])[:1]])
        c = gpd.GeoSeries(gpd.points_from_xy(cached_pts[:, 0], cached_pts[:, 1]), crs=4326).to_crs(CRS)
        cx, cy = c.x.values, c.y.values
        missing = [i for i, p in enumerate(sites.geometry) if not np.any((np.abs(cx - p.x) < 150) & (np.abs(cy - p.y) < 150))]
        if missing:
            print(f"  fetching buildings for {len(missing)} new sites", flush=True)
            els += fetch_buildings(sites.iloc[missing])
            path.write_text(json.dumps(els))
    else:
        els = fetch_buildings(sites)
        path.write_text(json.dumps(els))
    els = {e["id"]: e for e in els}.values()
    rows = []
    for e in els:
        poly = way_polygon(e.get("geometry", []))
        if poly is not None and poly.is_valid:
            t = e.get("tags", {})
            label = " ".join(str(t.get(k, "")) for k in ("name", "building", "leisure", "sport")).lower()
            rows.append((e["id"], label, poly))
    g = gpd.GeoDataFrame(rows, columns=["bid", "label", "geometry"], crs=4326).to_crs(CRS)
    g["sqft"] = g.area * SQFT
    g["gym"] = g.label.str.contains("|".join(GYM_WORDS)) | g.label.str.contains("sports_hall|sports_centre")
    return g


def main():
    pts = json.load(open(DOCS / "points.json"))["features"]
    sites = pd.DataFrame([{**f["properties"], "lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1]}
                          for f in pts if f["properties"].get("b")])
    sites = gpd.GeoDataFrame(sites, geometry=gpd.points_from_xy(sites.lon, sites.lat), crs=4326).to_crs(CRS)
    print(f"{len(sites)} shelter sites")
    camp = campuses()
    print(f"{len(camp)} site outlines")
    bld = buildings(sites)
    print(f"{len(bld)} buildings near sites")
    bld_centers = gpd.GeoDataFrame(bld[["bid"]], geometry=bld.geometry.representative_point(), crs=CRS)
    bsindex = bld.sindex

    review = []
    for s in sites.itertuples():
        pt = s.geometry
        cand = camp[camp.amenity.isin(SITE_TYPES[s.b])]
        cand = cand.iloc[cand.sindex.query(pt.buffer(NEAR_M), predicate="intersects")]
        method, members = "none", bld.iloc[0:0]
        if len(cand):
            inside = cand[cand.contains(pt)]
            outline = (inside if len(inside) else cand.assign(d=cand.distance(pt)).sort_values("d").head(1)).sort_values("area").geometry.iloc[0]
            ids = bld_centers.iloc[bld_centers.sindex.query(outline, predicate="contains")].bid
            members = bld[bld.bid.isin(ids)]
            method = "campus"
        if not len(members):
            hit = bld.iloc[bsindex.query(pt, predicate="intersects")]
            if len(hit):
                members, method = hit, "building"
            else:
                near = bld.iloc[bsindex.query(pt.buffer(NEAR_M), predicate="intersects")]
                if len(near):
                    members, method = near.assign(d=near.distance(pt)).sort_values("d").head(1), "nearest"
        if not len(members):
            review.append((s.id, s.n, s.c, s.b, "none", 0, 0, 0))
            continue
        biggest = members.sqft.max()
        gyms = members[members.gym & ((members.sqft >= GYM_MIN_SQFT) | (members.sqft >= 0.4 * biggest))]
        main = (gyms if len(gyms) else members).sort_values("sqft").iloc[-1]
        kind = "gym" if len(gyms) else "largest"
        review.append((s.id, s.n, s.c, s.b, f"{method}/{kind}", len(members), int(main.sqft), int(members.sqft.sum())))

    rv = pd.DataFrame(review, columns=["id", "name", "city", "bucket", "method", "buildings", "main_sqft", "total_sqft"])
    med = rv[rv.method != "none"].groupby("bucket").main_sqft.median()
    m = rv.bucket.map(med)
    rv["flag"] = np.select(
        [rv.method == "none", rv.main_sqft > 3 * m, rv.main_sqft < 0.25 * m,
         rv.method.str.startswith("nearest") & rv.bucket.isin(CAMPUS_BUCKETS)],
        ["no match", "too large for type", "too small for type", "nearest building only"], default="")
    good = rv[rv.flag == ""]
    q = good.groupby("bucket").main_sqft.quantile([0.25, 0.75]).unstack()
    lo, hi = rv.bucket.map(q[0.25]), rv.bucket.map(q[0.75])
    rv["rel"] = np.where(rv.flag != "", "?", np.where(rv.main_sqft > hi, "L", np.where(rv.main_sqft < lo, "S", "T")))
    out = {int(r.id): [int(round(r.main_sqft, -2)) if r.rel != "?" else 0, r.rel] for r in rv.itertuples()}
    (DOCS / "site_size.json").write_text(json.dumps(out, separators=(",", ":")))
    rv.to_csv(ROOT / "data" / "work" / "site_size_review.csv", index=False)

    print("\nmethod:", rv.method.str.split("/").str[0].value_counts().to_dict(), "| gym used:", int(rv.method.str.endswith("gym").sum()))
    print("flags:", rv.flag.replace("", "ok").value_counts().to_dict())
    print("\ntypical main-building size by type (middle half of trusted sites, sq ft):")
    print(pd.DataFrame({"sites": good.groupby("bucket").size(), "p25": q[0.25].round(-2), "median": good.groupby("bucket").main_sqft.median().round(-2), "p75": q[0.75].round(-2)}).to_string())


if __name__ == "__main__":
    main()
