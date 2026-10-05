"""Walking and driving distance from shelter sites to flooded census blocks, for every scenario.

Replaces straight-line distance in 06_key_shelters.py, 11_capacity_gaps.py and 12_outreach_list.py.

A path segment is closed where any sample point (every 10 m) lies in the scenario's flood layers; bridges and tunnels
never close. Walking uses the OSM walking network (roads, footpaths, service roads; no motorways) out to 2 km, which
covers the 1 km and 2 km picker settings. Driving uses the OSM drivable roads out to 5 km. Residents of a flooded
block start from the nearest open path node within 500 m (a block with none reaches nothing); a shelter site attaches
to the nearest open node within 300 m, and the straight-line hop to the node is added to the route.

Run after 04_points.py. Cached per scenario in data/work/access/<scenario>.npz (reused while the site list and block
list are unchanged; pass --force to recompute).
Each file: walk_site, walk_block, walk_m and drive_site, drive_block, drive_m (one row per reachable pair), where
site is a row in common.shelter_sites() and block is a row in data/work/block_flood.npz.
"""
import hashlib
import sys
import time

import geopandas as gpd
import numpy as np
import shapely

from common import (ACCESS, FLOOD, LAYERS, WORK, closed_edges, network_reach, road_network, scenario_keys, scenario_layers,
                    shelter_sites, walk_network)
WALK_M, DRIVE_M = 2000, 5000
OUT = ACCESS


def log(t0, msg):
    print(f"{time.time() - t0:7.1f}s  {msg}", flush=True)


def main():
    t0 = time.time()
    force = "--force" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    z = np.load(WORK / "block_flood.npz")
    keys, F, bx, by = list(z["keys"]), z["pop"], z["x"], z["y"]
    ids, sx, sy = shelter_sites()
    signature = hashlib.sha1(ids.tobytes() + np.round(sx).tobytes() + np.round(sy).tobytes() + F.tobytes()).hexdigest()
    todo = [k for k in scenario_keys() if force or not (OUT / f"{k}.npz").exists()
            or str(np.load(OUT / f"{k}.npz")["signature"]) != signature]
    log(t0, f"{len(ids)} sites, {len(bx)} blocks, {len(todo)} of {len(keys)} scenarios to compute")
    if not todo:
        return
    nets = {"walk": walk_network(), "drive": road_network()}
    log(t0, "networks: " + ", ".join(f"{m} {len(n['a']):,} segments" for m, n in nets.items()))
    need = sorted({layer for k in todo for layer in scenario_layers(k)}, key=LAYERS.index)
    closed = {m: {} for m in nets}
    for layer in need:
        flood = gpd.read_file(FLOOD, layer=layer).geometry.iloc[0]
        for m, net in nets.items():
            closed[m][layer] = closed_edges(net, flood)
        log(t0, f"closed segments, {layer}: " + ", ".join(f"{m} {closed[m][layer].sum():,}" for m in nets))
    for key in todo:
        fl = np.flatnonzero(F[keys.index(key)] > 0)
        result = {"signature": np.array(signature)}
        for mode, limit in (("walk", WALK_M), ("drive", DRIVE_M)):
            net = nets[mode]
            shut = np.zeros(len(net["a"]), bool)
            for layer in scenario_layers(key):
                shut |= closed[mode][layer]
            s, b, d = network_reach(net, shut, np.c_[sx, sy], np.c_[bx[fl], by[fl]], limit)
            result[f"{mode}_site"], result[f"{mode}_block"], result[f"{mode}_m"] = s.astype(np.int32), fl[b].astype(np.int32), d.astype(np.float32)
        np.savez_compressed(OUT / f"{key}.npz", **result)
        log(t0, f"{key}: {len(fl)} flooded blocks, walk pairs {len(result['walk_m']):,}, drive pairs {len(result['drive_m']):,}")


if __name__ == "__main__":
    main()
