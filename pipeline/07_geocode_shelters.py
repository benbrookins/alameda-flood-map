"""Locate pre-identified shelter sites from data/raw/shelters/jurisdiction_shelters.csv.

Matches each site to an existing school/community/library/worship point in the same city when the names
are close, otherwise searches OpenStreetMap Nominatim (1 request per second, bounded to the county).
Run 04_points.py first (it writes data/work/points_generic.json), then this, then 04_points.py again.
Manual fixes go in data/raw/shelters/overrides.csv (city,name,lat,lon). Output for review:
data/raw/shelters/geocoded.csv (city,name,lat,lon,source,matched).
"""
import csv
import difflib
import json
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "raw" / "shelters"
HEADERS = {"User-Agent": "alameda-flood-map/0.1 (research dashboard)"}
VIEWBOX = "-122.38,37.93,-121.45,37.44"
CITY_PLACES = {"Castro Valley": {"Castro Valley", "Unincorporated"}, "San Lorenzo": {"San Lorenzo", "Ashland", "Unincorporated"},
               "San Leandro": {"San Leandro", "Ashland", "Unincorporated"}, "Sunol": {"Sunol", "Unincorporated"},
               "Hayward": {"Hayward", "Cherryland", "Fairview", "Unincorporated"}}
# Names on the list that differ from the name in our point data (checked by hand).
SAME_AS = {
    "Valley High School-Stager Gym": "Valley High (Continuation)",
    "Eleanor M. Fallon Middle School": "Eleanor Murray Fallon",
    "Emeryville Senior Center / Veterans Memorial": "Emeryville Senior Center",
    'Irvington "Wally Pond" Community Center': "Irvington Community Center",
    "Age Well - Lake Elizabeth - Fremont Senior Center": "Age Well Center at Lake Elizabeth",
    "San Leandro Main Public Library": "San Leandro Community Library",
}
# Better search terms for OpenStreetMap place search.
SEARCH_AS = {
    "Live Oak Community Center": ["Live Oak Park Community Center, Berkeley", "Live Oak Park, Berkeley"],
    "Ohlone Community College": ["Ohlone College, Fremont"],
    "Matt Jimenez Community Center": ["Matt Jimenez Community Center, Hayward", "Jimenez Community Center, Hayward"],
    "Cherryland Community Center": ["Cherryland Community Center", "Cherryland Community Center, Hayward"],
    "Hayward Area Senior Center": ["Hayward Senior Center, Hayward", "Senior Center, Hayward"],
    "San Felipe Community Center": ["San Felipe Community Center, Hayward", "San Felipe Park, Hayward"],
    "Sorensdale Recreation Center": ["Sorensdale Recreation Center, Hayward", "Sorensdale Park, Hayward"],
    "Cal State East Bay": ["California State University East Bay, Hayward", "Cal State East Bay, Hayward"],
    "Chinese for Christ Church in Hayward": ["Chinese for Christ Church, Hayward", "Chinese for Christ, Hayward"],
    "Las Positas Community College": ["Las Positas College, Livermore"],
    "George M Silliman Community Activity Center": ["Silliman Activity Center, Newark", "Silliman Family Aquatic Center, Newark"],
    "Ira Jinkins Recreation Center": ["Ira Jinkins Recreation Center, Oakland", "Jinkins Recreation Center, Oakland"],
    "Willie Keyes Community Recreation Center": ["Willie Keyes Recreation Center, Oakland", "Willie Keyes, Oakland"],
    "Ashland Youth Center (REACH) County Bldg": ["REACH Ashland Youth Center", "Ashland Youth Center, San Leandro"],
    "Sunol Glen Elementary School": ["Sunol Glen School, Sunol", "Sunol Glen"],
    "The Mark Green Sports Center": ["Mark Green Sports Center, Union City"],
}
DROP = {"the", "school", "of", "and", "center", "community", "public"}


def norm(s):
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower().replace("&", " and "))
    return " ".join(w for w in s.split() if w not in DROP)


def nominatim(name, city):
    queries = [f"{q}, California" for q in SEARCH_AS.get(name, [])] or \
        [f"{name}, {city}, California", f"{re.sub(r'[(].*?[)]', '', name)}, {city}, California"]
    for q in queries:
        r = requests.get("https://nominatim.openstreetmap.org/search", headers=HEADERS, timeout=60,
                         params={"q": q, "format": "jsonv2", "limit": 1, "viewbox": VIEWBOX, "bounded": 1})
        time.sleep(1.1)
        if r.ok and r.json():
            h = r.json()[0]
            return float(h["lat"]), float(h["lon"]), h["display_name"][:90]
    return None


def main():
    pts = json.load(open(ROOT / "data" / "work" / "points_generic.json"))["features"]
    cands = [f for f in pts if f["properties"]["k"] in ("school", "community", "library", "worship")]
    overrides = {}
    if (DIR / "overrides.csv").exists():
        for r in csv.DictReader(open(DIR / "overrides.csv")):
            overrides[(r["city"], r["name"])] = (float(r["lat"]), float(r["lon"]))
    out = []
    for row in csv.DictReader(open(DIR / "jurisdiction_shelters.csv")):
        city, name = row["city"], row["name"]
        if (city, name) in overrides:
            lat, lon = overrides[(city, name)]
            out.append([city, name, lat, lon, "override", ""])
            continue
        if name in SAME_AS:
            f = next(f for f in cands if f["properties"]["n"] == SAME_AS[name])
            lon, lat = f["geometry"]["coordinates"]
            out.append([city, name, lat, lon, "match (manual)", f["properties"]["n"]])
            continue
        places = CITY_PLACES.get(city, {city})
        best, score = None, 0
        for f in cands:
            if f["properties"]["c"] not in places:
                continue
            s = difflib.SequenceMatcher(None, norm(name), norm(f["properties"]["n"])).ratio()
            if s > score:
                best, score = f, s
        if best and score >= 0.82 and name not in SEARCH_AS:
            lon, lat = best["geometry"]["coordinates"]
            out.append([city, name, lat, lon, f"match {score:.2f}", best["properties"]["n"]])
            continue
        hit = nominatim(name, city)
        if hit:
            out.append([city, name, hit[0], hit[1], "nominatim", hit[2]])
        else:
            out.append([city, name, "", "", "NOT FOUND", f"closest point: {best['properties']['n'] if best else ''} ({score:.2f})"])
    with open(DIR / "geocoded.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["city", "name", "lat", "lon", "source", "matched"])
        w.writerows(out)
    for r in out:
        print(f"{r[0]:<13} {r[1][:44]:<45} {r[4]:<11} {r[5]}")


if __name__ == "__main__":
    main()
