"""Download raw source data into data/raw/. Usage: uv run pipeline/01_download.py [source ...]

Sources: fema, noaa_slr, census_geo, acs, block_pop, tides, schools, osm, osm_facilities, osm_roads (default), plus
the parked, optional art and art_roads, which must be named explicitly.
"""
import json
import os
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
HEADERS = {"User-Agent": "alameda-flood-map/0.1 (research dashboard)"}

ART_POLY = "https://geodata.dot.ca.gov/arcgis/rest/services/CHhqenvi/DEA_BCDC_polygon_SLR/FeatureServer"
ART_ROADS = "https://gisdata.dot.ca.gov/arcgis/rest/services/CHhqenvi/DEA_BCDC_SLR/FeatureServer"
FEMA_HAZ = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"

# inches above MHHW -> layer id. Layer 3 (48 in) is empty in this service, so 52 in is the top step.
ART_LAYERS = {12: 0, 24: 1, 36: 2, 52: 4}
ALAMEDA_BBOX = "-122.40,37.45,-121.46,37.91"  # lon/lat, a bit wider than the county
BBOX_PARAMS = {"geometry": ALAMEDA_BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
               "spatialRel": "esriSpatialRelIntersects"}
STATION = "9414750"  # NOAA Alameda


def get(url, **kw):
    for attempt in range(4):
        try:
            r = requests.get(url, headers=HEADERS, timeout=180, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == 3:
                raise
            print(f"  retry ({e})")
            time.sleep(3 * (attempt + 1))


def save(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode())
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")


def arcgis_geojson(layer_url, where="1=1", page=200, extra=None):
    """Page through an ArcGIS layer as WGS84 GeoJSON features."""
    feats, offset = [], 0
    while True:
        params = {"where": where, "outFields": "*", "outSR": 4326, "f": "geojson",
                  "resultOffset": offset, "resultRecordCount": page, **(extra or {})}
        data = get(f"{layer_url}/query", params=params).json()
        batch = data.get("features", [])
        feats += batch
        if not batch:
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": feats}


def art():
    for inches, layer in ART_LAYERS.items():
        out = RAW / "art" / f"slr_{inches}in.geojson"
        if out.exists():
            print(f"ART polygons {inches} in: already downloaded")
            continue
        print(f"ART polygons {inches} in")
        # Features are huge (tens of MB each), so request a few at a time, clipped to the county bbox.
        extra = {**BBOX_PARAMS, "maxAllowableOffset": 0.0001, "geometryPrecision": 5}
        fc = arcgis_geojson(f"{ART_POLY}/{layer}", page=3, extra=extra)
        print(f"  {len(fc['features'])} features")
        save(RAW / "art" / f"slr_{inches}in.geojson", json.dumps(fc))


def art_roads():
    for inches, layer in ART_LAYERS.items():
        print(f"ART road/rail {inches} in")
        fc = arcgis_geojson(f"{ART_ROADS}/{layer}", page=500)
        save(RAW / "art" / f"roadrail_{inches}in.geojson", json.dumps(fc))


def fema():
    print("FEMA NFHL flood hazard areas, Alameda County (DFIRM 06001C)")
    fc = arcgis_geojson(FEMA_HAZ, where="DFIRM_ID='06001C'", page=200)
    print(f"  {len(fc['features'])} features")
    save(RAW / "fema" / "nfhl_flood_hazard.geojson", json.dumps(fc))


def census_geo():
    for name, url in {
        "tracts_ca.zip": "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_06_tract_500k.zip",
        "places_ca.zip": "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_06_place_500k.zip",
        "blocks_alameda.zip": "https://www2.census.gov/geo/tiger/TIGER2020PL/STATE/06_CALIFORNIA/06001/tl_2020_06001_tabblock20.zip",
    }.items():
        print(name)
        save(RAW / "census" / name, get(url).content)


ACS_GROUPS = ["B01003", "B11001", "B25044", "B01001", "B18101", "B17001", "B19013", "C16002", "B25003"]


def acs():
    load_env()
    key = os.environ["CENSUS_API_KEY"]
    for g in ACS_GROUPS:
        print(f"ACS {g}")
        url = f"https://api.census.gov/data/2024/acs/acs5?get=NAME,group({g})&for=tract:*&in=state:06&in=county:001&key={key}"
        save(RAW / "census" / f"acs_{g}.json", get(url).content)


def noaa_slr():
    out = RAW / "noaa" / "CA_SFBay_slr_data_dist.zip"
    if out.exists():
        print("NOAA SLR SFBay: already downloaded")
        return
    print("NOAA SLR vectors, SF Bay (includes low-lying disconnected areas)")
    save(out, get("https://coast.noaa.gov/slrdata/Sea_Level_Rise_Vectors/CA/CA_SFBay_slr_data_dist.zip").content)


def block_pop():
    load_env()
    key = os.environ["CENSUS_API_KEY"]
    print("2020 block population and housing units")
    url = ("https://api.census.gov/data/2020/dec/pl?get=P1_001N,H1_001N&for=block:*"
           f"&in=state:06&in=county:001&in=tract:*&key={key}")
    save(RAW / "census" / "block_pop_2020.json", get(url).content)


def tides():
    print(f"NOAA station {STATION}")
    base = "https://api.tidesandcurrents.noaa.gov"
    save(RAW / "noaa" / "datums.json", get(f"{base}/mdapi/prod/webapi/stations/{STATION}/datums.json?units=english").content)
    for label, begin, end in [("predictions_2026_27", "20261001", "20270331")]:
        url = (f"{base}/api/prod/datagetter?station={STATION}&product=predictions&datum=MHHW"
               f"&begin_date={begin}&end_date={end}&interval=hilo&units=english&time_zone=lst_ldt&format=json")
        save(RAW / "noaa" / f"{label}.json", get(url).content)


def schools():
    print("CDE public schools directory")
    save(RAW / "schools" / "pubschls.txt", get("https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt").content)


OSM_QUERY = """
[out:json][timeout:180];
area["boundary"="administrative"]["name"="Alameda County"]["admin_level"="6"]->.a;
(
  nwr["amenity"~"^(community_centre|library|place_of_worship|fire_station|police)$"](area.a);
);
out center tags;
"""


def osm():
    print("OSM amenities via Overpass")
    r = requests.post("https://overpass-api.de/api/interpreter", data={"data": OSM_QUERY}, headers=HEADERS, timeout=240)
    r.raise_for_status()
    print(f"  {len(r.json()['elements'])} elements")
    save(RAW / "osm" / "amenities.json", r.content)


FACILITY_QUERY = """
[out:json][timeout:240];
area["boundary"="administrative"]["name"="Alameda County"]["admin_level"="6"]->.a;
(
  nwr["amenity"~"^(hospital|nursing_home)$"](area.a);
  nwr["amenity"="social_facility"]["social_facility"~"^(assisted_living|nursing_home|group_home)$"](area.a);
  nwr["healthcare"="dialysis"](area.a);
);
out center tags;
"""

ROADS_QUERY = """
[out:json][timeout:300];
area["boundary"="administrative"]["name"="Alameda County"]["admin_level"="6"]->.a;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](area.a);
out geom tags;
"""


OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter"]


def overpass(query, out_name):
    for attempt in range(6):
        url = OVERPASS_SERVERS[attempt % len(OVERPASS_SERVERS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=420)
            r.raise_for_status()
            n = len(r.json()["elements"])
            print(f"  {n} elements from {url.split('/')[2]}")
            save(RAW / "osm" / out_name, r.content)
            return
        except (requests.RequestException, ValueError) as e:
            print(f"  {url.split('/')[2]} failed ({str(e)[:60]}); retrying")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass failed for {out_name}")


def osm_facilities():
    print("OSM hospitals, care homes, dialysis")
    overpass(FACILITY_QUERY, "facilities.json")


def osm_roads():
    print("OSM major roads")
    overpass(ROADS_QUERY, "roads.json")


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


SOURCES = {f.__name__: f for f in [art, art_roads, fema, noaa_slr, census_geo, acs, block_pop, tides, schools, osm, osm_facilities, osm_roads]}

if __name__ == "__main__":
    parked = {"art", "art_roads"}  # optional, slow; name them explicitly to download
    for name in sys.argv[1:] or [s for s in SOURCES if s not in parked]:
        SOURCES[name]()
