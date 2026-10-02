"""Shelter capacity: surveyed values for pre-identified shelters, type-based estimates for other sites.

Input: data/raw/shelters/surveyed.csv (gitignored): usable sleeping sq ft, short-term evacuation capacity, and
overnight (post-impact) capacity for the pre-identified shelters. Overnight capacity there is consistently
usable sq ft / 45. Run after 04_points.py (uses its site ids and buckets).

Estimates for other sites use the median (and middle half) of surveyed sites of the same type, only for types with
at least MIN_SURVEYED surveyed sites. In a leave-one-out test this type median was off by a median of 27%; scaling
building footprints did not do better, so footprints are not used for capacity.

Outputs (no names or contacts from the survey file):
  docs/data/capacity.json  {"types": {bucket: {overnight, low, high, evacuation, surveyed}}, "sites": {id: [overnight, evacuation, role]}}
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SURVEY = ROOT / "data" / "raw" / "shelters" / "surveyed.csv"
POINTS = ROOT / "docs" / "data" / "points.json"
OUT = ROOT / "docs" / "data" / "capacity.json"
MIN_SURVEYED = 4


def main():
    sv = pd.read_csv(SURVEY)
    pre = {f["properties"]["n"]: f["properties"] for f in json.load(open(POINTS))["features"] if f["properties"]["k"] == "pre"}
    missing = sorted(set(sv.name) - set(pre))
    if missing:
        print("WARNING: surveyed sites not found on the map:", missing)
    sv = sv[sv.name.isin(pre)].copy()
    sv["id"] = sv.name.map(lambda n: pre[n]["id"])
    sv["b"] = sv.name.map(lambda n: pre[n]["b"])

    types = {}
    for b, g in sv.groupby("b"):
        if len(g) >= MIN_SURVEYED:
            types[b] = {"overnight": int(g.post_cap.median()), "low": int(g.post_cap.quantile(0.25)),
                        "high": int(g.post_cap.quantile(0.75)), "evacuation": int(g.evac_cap.median()), "surveyed": len(g)}
    sites = {int(r.id): [int(r.post_cap), int(r.evac_cap), r.role.lower() if r.role in ("Primary", "Secondary") else ""]
             for r in sv.itertuples()}
    OUT.write_text(json.dumps({"types": types, "sites": sites}, separators=(",", ":")))
    print(f"{len(sites)} surveyed sites; type estimates for: {', '.join(f'{b} (~{v['overnight']})' for b, v in types.items())}")
    print(f"total surveyed overnight capacity: {int(sv.post_cap.sum()):,}; evacuation: {int(sv.evac_cap.sum()):,}")


if __name__ == "__main__":
    main()
