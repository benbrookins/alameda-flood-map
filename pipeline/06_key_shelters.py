"""How many flooded residents live near each potential shelter, per scenario.

For each shelter site and scenario, counts flooded residents (and flooded residents without a car,
estimated from the tract's no-car household share) within a 1 km walk, a 2 km walk, and a 5 km drive of block centers,
along open paths and roads (distances from 14_access.py; flooded paths are closed).

Output: docs/data/shelter_reach.json  {scenario: {site id: [people, no-car] for 1 km, 2 km, 5 km}}
Sites with fewer than MIN_STORE affected residents within 5 km in a scenario are left out.
"""
import json

import geopandas as gpd
import numpy as np

from common import DOCS, WORK, load_access, scenario_keys, shelter_sites
RADII = (("walk", 1000), ("walk", 2000), ("drive", 5000))
MIN_STORE = 50


def main():
    z = np.load(WORK / "block_flood.npz")
    keys, flooded = list(z["keys"]), z["pop"].astype(np.float64)  # scenarios x blocks
    tract = z["tract"]

    tr = gpd.read_file(DOCS / "tracts.geojson")
    share = (tr["nocar"].astype(float) / tr["hh"].astype(float).where(tr["hh"] > 0)).fillna(0)
    share_by_tract = dict(zip(tr["GEOID"].str[5:], share))
    nc = np.array([share_by_tract.get(t, 0.0) for t in tract])
    flooded_nc = flooded * nc  # flooded residents without a car, estimated

    ids = shelter_sites()[0]
    out = {k: {} for k in keys}
    for j, key in enumerate(keys):
        tables = load_access(key)
        cols = []
        for mode, r in RADII:
            near = tables[f"{mode}_m"] <= r
            site, block = tables[f"{mode}_site"][near], tables[f"{mode}_block"][near]
            for w in (flooded[j], flooded_nc[j]):
                cols.append(np.bincount(site, weights=w[block], minlength=len(ids)))
        for i, sid in enumerate(ids):
            vals = [int(round(c[i])) for c in cols]
            if vals[4] >= MIN_STORE:
                out[key][int(sid)] = vals
    path = DOCS / "shelter_reach.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(ids)} sites x {len(keys)} scenarios -> {path.name} ({path.stat().st_size / 1e3:.0f} KB)")
    for key in ("b2_r0_c0", "b3_r0_c0", "b4_r0_c1", "b0_r100_c0", "b0_r500_c0"):
        n1 = sum(1 for v in out[key].values() if v[0] + v[1] >= 100)
        n2 = sum(1 for v in out[key].values() if v[2] + v[3] >= 100)
        print(f"{key}: {len(out[key])} stored; with score>=100: {n1} within a 1 km walk, {n2} within a 2 km walk")


if __name__ == "__main__":
    main()
