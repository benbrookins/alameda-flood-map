"""Paths, flood-layer names, and helpers shared by the pipeline scripts."""
import json
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"      # downloads (gitignored)
WORK = ROOT / "data" / "work"    # intermediates (gitignored)
DOCS = ROOT / "docs" / "data"    # published with the site
FLOOD = WORK / "flood_full.gpkg"
CRS = 3310                       # California Albers, meters
HEADERS = {"User-Agent": "alameda-flood-map/0.1 (research dashboard)"}
COUNTY_BBOX = "37.44,-122.38,37.93,-121.45"  # south, west, north, east (Overpass order)

BAY_LEVELS = [0, 1, 2, 2.5, 3, 4]  # feet above normal high tide (MHHW); 0 = no Bay flooding

# Flood layers in bitmask order: bits 0-3 Bay +1..+4 ft, 4-7 low-lying +1..+4 ft, 8 FEMA 100-yr, 9 FEMA 500-yr,
# 10-11 Bay and low-lying +2.5 ft (added later, appended so earlier bit positions stay the same).
LAYERS = ([f"bay_{i}ft" for i in range(1, 5)] + [f"low_{i}ft" for i in range(1, 5)] + ["fema_100yr", "fema_500yr"]
          + ["bay_2.5ft", "low_2.5ft"])
OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter"]


def scenario_keys():
    """Every scenario key: Bay level x FEMA zone (0, 100, 500) x low-lying areas (0/1)."""
    return [f"b{b:g}_r{r}_c{c}" for b in BAY_LEVELS for r in (0, 100, 500) for c in (0, 1)]


def scenario_layers(key):
    """Flood layers in a scenario key such as 'b2.5_r100_c1' (Bay +2.5 ft, FEMA 100-yr zone, low-lying areas on)."""
    b, r, c = (float(x[1:]) for x in key.split("_"))
    layers = ([f"bay_{b:g}ft"] if b else []) + ([f"low_{b:g}ft"] if b and c else [])
    if r:
        layers.append("fema_100yr" if r == 100 else "fema_500yr")
    return layers


def scenario_mask(key):
    return sum(1 << LAYERS.index(name) for name in scenario_layers(key))


def county_land():
    """Alameda County land area (union of census tracts), EPSG:3310."""
    t = gpd.read_file(f"zip://{RAW / 'census' / 'tracts_ca.zip'}").to_crs(CRS)
    land = t[t.COUNTYFP == "001"].union_all()
    return land if shapely.is_valid(land) else shapely.make_valid(land)


def overpass(query, attempts=8):
    """Run an Overpass API query with retries (mostly on the main server, occasionally a mirror); returns elements."""
    for attempt in range(attempts):
        url = OVERPASS_SERVERS[0 if attempt % 4 else attempt // 4 % len(OVERPASS_SERVERS)]
        try:
            r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=420)
            r.raise_for_status()
            return r.json()["elements"]
        except (requests.RequestException, ValueError) as e:
            print(f"  {url.split('/')[2]} failed ({str(e)[:60]}); retrying", flush=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Overpass query failed")


def block_shapes(bx, by):
    """Populated 2020 blocks (EPSG:3310) in the same order as data/work/block_flood.npz, with pop and hu columns.

    Checks each block's interior point against the stored block location, so a mismatch fails loudly."""
    raw = RAW / "census"
    rows = json.load(open(raw / "block_pop_2020.json"))
    pop = pd.DataFrame(rows[1:], columns=rows[0])
    pop["GEOID20"] = pop.state + pop.county + pop.tract + pop.block
    pop["pop"], pop["hu"] = pop.P1_001N.astype(int), pop.H1_001N.astype(int)
    b = gpd.read_file(f"zip://{raw / 'blocks_alameda.zip'}")[["GEOID20", "geometry"]].to_crs(CRS)
    b = b.merge(pop[["GEOID20", "pop", "hu"]], on="GEOID20", how="left", validate="1:1")
    b = b[(b["pop"] > 0) | (b["hu"] > 0)].reset_index(drop=True)
    pts = b.geometry.representative_point()
    off = np.hypot(pts.x.values - bx, pts.y.values - by)
    assert len(b) == len(bx) and off.max() < 1.0, f"block order mismatch (max offset {off.max():.0f} m)"
    return b


def build_network(els):
    """Graph from OSM ways with geometry. Returns a dict: node lon/lat and x/y (EPSG:3310); edge endpoints a/b,
    at_grade (False for bridges and tunnels), and the road name of each edge."""
    node_id, lon, lat, ea, eb, grade, names = {}, [], [], [], [], [], []
    for e in els:
        g = e.get("geometry") or []
        if len(g) < 2:
            continue
        t = e.get("tags", {})
        at_grade = t.get("bridge") in (None, "no") and t.get("tunnel") in (None, "no")
        name = t.get("name") or t.get("ref") or ""
        prev = None
        for p in g:
            k = (round(p["lon"], 7), round(p["lat"], 7))
            i = node_id.get(k)
            if i is None:
                i = node_id[k] = len(lon)
                lon.append(k[0])
                lat.append(k[1])
            if prev is not None and prev != i:
                ea.append(prev)
                eb.append(i)
                grade.append(at_grade)
                names.append(name)
            prev = i
    pts = gpd.GeoSeries(gpd.points_from_xy(lon, lat), crs=4326).to_crs(CRS)
    return {"lon": np.array(lon), "lat": np.array(lat), "x": pts.x.values, "y": pts.y.values,
            "a": np.array(ea), "b": np.array(eb), "at_grade": np.array(grade), "name": np.array(names, dtype=object)}


def road_network():
    """OSM drivable roads (data/raw/osm/all_roads.json) as a graph; the driving network. See build_network()."""
    return build_network(json.load(open(RAW / "osm" / "all_roads.json"))["elements"])


NO_WALKING = {"motorway", "motorway_link", "trunk", "trunk_link"}


def walk_network():
    """The walking network: drivable roads plus footpaths and service roads (data/raw/osm/walk_paths.json), without
    motorways, trunk roads, or ways tagged foot=no. Bridges and tunnels are flagged as in road_network()."""
    els = {}
    for name in ("all_roads.json", "walk_paths.json"):
        for e in json.load(open(RAW / "osm" / name))["elements"]:
            t = e.get("tags", {})
            if t.get("highway") not in NO_WALKING and t.get("foot") != "no":
                els[e["id"]] = e
    return build_network(list(els.values()))


def edge_samples(net, idx, spacing_m):
    """Sample points along road segments idx, at most spacing_m apart, ends included.

    Returns (owner, t): for each point, the position in idx of its segment and the fraction (0 to 1) along it."""
    a, b = net["a"][idx], net["b"][idx]
    length = np.hypot(net["x"][a] - net["x"][b], net["y"][a] - net["y"][b])
    k = np.maximum(2, np.ceil(length / spacing_m).astype(int) + 1)
    return np.repeat(np.arange(len(idx)), k), np.concatenate([np.linspace(0, 1, m) for m in k])


def closed_edges(net, flood, spacing_m=10):
    """Boolean per segment: True where a sample point along an at-grade segment lies in the flood geometry (EPSG:3310).
    Bridges and tunnels never close."""
    idx = np.flatnonzero(net["at_grade"])
    owner, t = edge_samples(net, idx, spacing_m)
    a, b = net["a"][idx][owner], net["b"][idx][owner]
    x = net["x"][a] * (1 - t) + net["x"][b] * t
    y = net["y"][a] * (1 - t) + net["y"][b] * t
    shapely.prepare(flood)
    hit = shapely.contains_xy(flood, x, y)
    per_edge = np.zeros(len(idx), bool)
    np.logical_or.at(per_edge, owner, hit)
    closed = np.zeros(len(net["a"]), bool)
    closed[idx] = per_edge
    return closed


def network_reach(net, closed, sources_xy, targets_xy, limit_m, snap_m=500, source_snap_m=300, batch=20):
    """Network distance from sources (shelter sites) to targets (flooded blocks) over the open segments of net.

    A target starts at the nearest node with an open segment within snap_m, a source within source_snap_m; the
    straight-line distance to that node is added to the route. Targets or sources with no such node reach nothing.
    sources_xy, targets_xy: arrays of shape (n, 2), EPSG:3310 meters.
    Returns (source index, target index, distance in meters) arrays for every pair within limit_m."""
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    from scipy.spatial import cKDTree

    sources_xy, targets_xy = np.asarray(sources_xy, float), np.asarray(targets_xy, float)
    empty = (np.zeros(0, int), np.zeros(0, int), np.zeros(0))
    if len(sources_xy) == 0 or len(targets_xy) == 0 or closed.all():
        return empty
    # a route is never shorter than the straight line, so skip sites with no target within the limit
    near, _ = cKDTree(targets_xy).query(sources_xy, distance_upper_bound=limit_m)
    live = np.flatnonzero(np.isfinite(near))
    if len(live) == 0:
        return empty
    a, b = net["a"][~closed], net["b"][~closed]
    length = np.hypot(net["x"][a] - net["x"][b], net["y"][a] - net["y"][b])
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    key = lo.astype(np.int64) * len(net["x"]) + hi        # parallel segments keep only the shortest
    order = np.lexsort((length, key))
    first = order[np.r_[True, np.diff(key[order]) != 0]]
    n = len(net["x"])
    graph = csr_matrix((length[first], (lo[first], hi[first])), shape=(n, n))
    nodes = np.unique(np.r_[a, b])
    tree = cKDTree(np.c_[net["x"][nodes], net["y"][nodes]])
    t_off, t_i = tree.query(targets_xy, distance_upper_bound=snap_m)
    t_ok = np.flatnonzero(np.isfinite(t_off))
    s_off, s_i = tree.query(sources_xy[live], distance_upper_bound=source_snap_m)
    s_ok = np.isfinite(s_off)
    live, s_off, s_i = live[s_ok], s_off[s_ok], s_i[s_ok]
    if len(t_ok) == 0 or len(live) == 0:
        return empty
    t_node, t_off = nodes[t_i[t_ok]], t_off[t_ok]
    s_node = nodes[s_i]
    t_nodes_u, t_back = np.unique(t_node, return_inverse=True)
    out_s, out_t, out_d = [], [], []
    for start in range(0, len(live), batch):
        sl = slice(start, start + batch)
        nodes_u, back = np.unique(s_node[sl], return_inverse=True)
        D = dijkstra(graph, directed=False, indices=nodes_u, limit=limit_m)[:, t_nodes_u]
        total = D[back][:, t_back] + s_off[sl][:, None] + t_off[None, :]
        si, ti = np.nonzero(total <= limit_m)
        out_s.append(live[sl][si])
        out_t.append(t_ok[ti])
        out_d.append(total[si, ti])
    return np.concatenate(out_s), np.concatenate(out_t), np.concatenate(out_d)
