"""Official lists of hospitals, care facilities, and dialysis clinics in Alameda County.

Sources (downloaded by 01_download.py state_facilities):
  CDPH licensed and certified healthcare facilities (has coordinates): hospitals, skilled nursing,
    intermediate care (developmental disabilities), congregate living health, chronic dialysis clinics.
  CDSS Community Care Licensing (addresses only): residential care for the elderly (assisted living) and
    adult residential facilities. Located with the Census batch geocoder; results cached.

Output: data/work/official_facilities.csv  (k, st, n, lat, lon, cap)  used by 04_points.py instead of
OpenStreetMap for hospitals, care facilities, and dialysis. Run before 04_points.py.
"""
import csv
import io
import time

import pandas as pd
import requests

from common import HEADERS, RAW, ROOT, WORK

DIR = RAW / "facilities"
OUT = WORK / "official_facilities.csv"
GEOCACHE = DIR / "ccl_geocoded.csv"

CDPH_TYPES = {  # FAC_FDR -> (kind, subtype)
    "GENERAL ACUTE CARE HOSPITAL": ("hospital", "acute"),
    "ACUTE PSYCHIATRIC HOSPITAL": ("hospital", "psych"),
    "SKILLED NURSING FACILITY": ("care", "snf"),
    "INTERMEDIATE CARE FACILITY-DD/H/N/CN/IID": ("care", "icf"),
    "CONGREGATE LIVING HEALTH FACILITY": ("care", "clhf"),
    "CHRONIC DIALYSIS CLINIC": ("dialysis", "dialysis"),
}
CCL_TYPES = {
    "RESIDENTIAL CARE ELDERLY": "rcfe", "RCFE-CONTINUING CARE RETIREMENT COMMUNITY": "rcfe",
    "ADULT RESIDENTIAL": "arf", "SOCIAL REHABILITATION FACILITY": "arf",
    "ADULT RESIDENTIAL FACILITY FOR PERSONS WITH SPECIAL HEALTH CARE NEEDS": "arf",
}


def tidy(name):
    return " ".join(w if any(c.isdigit() for c in w) else w.capitalize() for w in str(name).split())


def cdph():
    c = pd.read_csv(DIR / "cdph_facilities.csv", dtype=str, encoding="latin1")
    c = c[c.COUNTY_NAME.str.upper().str.contains("ALAMEDA", na=False) & c.FAC_FDR.isin(CDPH_TYPES)]
    c = c[c.LICENSE_STATUS_DESCRIPTION.eq("ACTIVE")]
    cap = pd.to_numeric(c.CAPACITY, errors="coerce").fillna(0).astype(int)
    c = c[(c.FAC_FDR != "CHRONIC DIALYSIS CLINIC") | (cap > 0)]  # drop home-dialysis programs with no stations
    rows = []
    for r in c.itertuples():
        k, st = CDPH_TYPES[r.FAC_FDR]
        rows.append((k, st, tidy(r.FACNAME), float(r.LATITUDE), float(r.LONGITUDE), int(float(r.CAPACITY or 0))))
    return rows


def geocode(df):
    cache = pd.read_csv(GEOCACHE, dtype={"id": str}) if GEOCACHE.exists() else pd.DataFrame(columns=["id", "lat", "lon", "match"])
    todo = df[~df.facility_number.isin(cache.id)]
    if len(todo):
        buf = io.StringIO()
        w = csv.writer(buf)
        for r in todo.itertuples():
            w.writerow([r.facility_number, r.facility_address, r.facility_city, "CA", str(r.facility_zip)[:5]])
        resp = requests.post("https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
                             files={"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")},
                             data={"benchmark": "Public_AR_Current"}, timeout=600)
        resp.raise_for_status()
        got = []
        for row in csv.reader(io.StringIO(resp.text)):
            if len(row) >= 6 and row[2] == "Match":
                lon, lat = map(float, row[5].split(","))
                got.append((row[0], lat, lon, row[3]))
            elif row:
                got.append((row[0], None, None, row[2]))
        cache = pd.concat([cache, pd.DataFrame(got, columns=["id", "lat", "lon", "match"])], ignore_index=True)
        cache.to_csv(GEOCACHE, index=False)
    retry = cache[cache.lat.isna() & ~cache.match.astype(str).str.startswith("nominatim")]
    if len(retry):
        addr = df.set_index("facility_number")
        for i in retry.index:
            r = addr.loc[cache.at[i, "id"]]
            hit = requests.get("https://nominatim.openstreetmap.org/search", timeout=60,
                               headers=HEADERS,
                               params={"street": r.facility_address, "city": r.facility_city, "state": "CA",
                                       "country": "USA", "format": "jsonv2", "limit": 1}).json()
            time.sleep(1.1)
            cache.at[i, "match"] = "nominatim" if hit else "nominatim-none"
            if hit:
                cache.at[i, "lat"], cache.at[i, "lon"] = float(hit[0]["lat"]), float(hit[0]["lon"])
        cache.to_csv(GEOCACHE, index=False)
    return df.merge(cache, left_on="facility_number", right_on="id", how="left")


def ccl():
    frames = []
    for f in ("ccl_elderly.csv", "ccl_adult.csv"):
        d = pd.read_csv(DIR / f, dtype=str, encoding="latin1")
        frames.append(d[(d.county_name.str.upper().str.strip() == "ALAMEDA")
                        & d.facility_status.str.upper().isin(["LICENSED", "ON PROBATION"])
                        & d.facility_type.isin(CCL_TYPES)])
    d = geocode(pd.concat(frames, ignore_index=True))
    missed = d[d.lat.isna()]
    if len(missed):
        print(f"  {len(missed)} care homes could not be located from their address:")
        for r in missed.itertuples():
            print(f"    {r.facility_name} | {r.facility_address}, {r.facility_city} ({r.match})")
    d = d.dropna(subset=["lat"])
    return [("care", CCL_TYPES[r.facility_type], tidy(r.facility_name), float(r.lat), float(r.lon),
             int(float(r.facility_capacity or 0))) for r in d.itertuples()]


def main():
    rows = cdph() + ccl()
    df = pd.DataFrame(rows, columns=["k", "st", "n", "lat", "lon", "cap"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False)
    print(df.groupby(["k", "st"]).agg(sites=("n", "size"), beds=("cap", "sum")).to_string())
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
