"""How many flooded residents live near each potential shelter, per scenario.

For each shelter site and scenario, counts flooded residents (and flooded residents without a car,
estimated from the tract's no-car household share) within 1, 2, and 5 km, as the crow flies, of block centers.

Output: docs/data/shelter_reach.json  {scenario: {site id: [people, no-car] for 1 km, 2 km, 5 km}}
Sites with fewer than MIN_STORE affected residents within 5 km in a scenario are left out.
"""
import json

import geopandas as gpd
import numpy as np

from common import DOCS, WORK
SHELTER_KINDS = {"pre", "school", "community", "library", "worship"}
RADII = (1000, 2000, 5000)
MIN_STORE = 50


def main():
    z = np.load(WORK / "block_flood.npz")
    keys, flooded = list(z["keys"]), z["pop"].astype(np.float64)  # scenarios x blocks
    bx, by, tract = z["x"], z["y"], z["tract"]

    tr = gpd.read_file(DOCS / "tracts.geojson")
    share = (tr["nocar"].astype(float) / tr["hh"].astype(float).where(tr["hh"] > 0)).fillna(0)
    share_by_tract = dict(zip(tr["GEOID"].str[5:], share))
    nc = np.array([share_by_tract.get(t, 0.0) for t in tract])
    flooded_nc = flooded * nc  # flooded residents without a car, estimated

    pts = json.load(open(DOCS / "points.json"))["features"]
    sites = [f for f in pts if f["properties"]["k"] in SHELTER_KINDS]
    g = gpd.GeoDataFrame({"id": [f["properties"]["id"] for f in sites]},
                         geometry=gpd.points_from_xy([f["geometry"]["coordinates"][0] for f in sites],
                                                     [f["geometry"]["coordinates"][1] for f in sites]), crs=4326).to_crs(3310)
    dist = np.hypot(g.geometry.x.values[:, None] - bx[None, :], g.geometry.y.values[:, None] - by[None, :])

    out = {k: {} for k in keys}
    cols = []
    for r in RADII:
        w = (dist <= r).astype(np.float64)
        cols += [w @ flooded.T, w @ flooded_nc.T]  # each: sites x scenarios
    for j, key in enumerate(keys):
        for i, sid in enumerate(g["id"]):
            vals = [int(round(c[i, j])) for c in cols]
            if vals[4] >= MIN_STORE:
                out[key][int(sid)] = vals
    path = DOCS / "shelter_reach.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(sites)} sites x {len(keys)} scenarios -> {path.name} ({path.stat().st_size / 1e3:.0f} KB)")
    for key in ("b2_r0_c0", "b3_r0_c0", "b4_r0_c1", "b0_r100_c0", "b0_r500_c0"):
        n1 = sum(1 for v in out[key].values() if v[0] + v[1] >= 100)
        n2 = sum(1 for v in out[key].values() if v[2] + v[3] >= 100)
        print(f"{key}: {len(out[key])} stored; with score>=100: {n1} within 1 km, {n2} within 2 km")


if __name__ == "__main__":
    main()
