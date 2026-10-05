"""Shelter capacity gaps: where pre-identified shelters fall short, and which potential sites could help.

For every scenario and distance (1 km walk, 2 km walk, 5 km drive), each flooded block's residents are assigned to the
nearest dry pre-identified shelter within that distance along open paths (walking) or roads (driving), with flooded
paths closed (distances from 14_access.py). Residents with none in range are "uncovered" and grouped
by city. For each shelter whose assigned residents exceed its overnight capacity (at 100% shelter use; the page applies
the chosen share), and for each city with uncovered residents, the dry potential shelter sites within range of those
residents are ranked by how many of them they could reach.

Run after 04_points.py, 14_access.py and 10_capacity.py.
Outputs: docs/data/uncovered/<scenario>.geojson  each separate area of blocks whose flooded residents have no
         pre-identified shelter in range (kind "area"), plus a label point per area (kind "label"), per km and city,
         with resident counts
        docs/data/capacity_gaps.json
  {scenario: {km: {"a": {pre id: assigned}, "u": {city: [uncovered, [[site id, reach], ...], [lon, lat]]},
                    "c": {pre id: [[site id, reach], ...]}}}}
"""
import json

import geopandas as gpd
import numpy as np
import shapely

from common import DOCS, ROOT, WORK, block_shapes, load_access, scenario_mask, shelter_sites
RADII_KM = (1, 2, 5)
POTENTIAL = {"school", "community", "library", "worship"}
TOP = 5
MIN_UNCOVERED = 20  # residents (at 100% shelter use) before a city counts as a coverage gap
SAME_SITE_M = 250   # potential sites this close to a pre-identified shelter are likely the same campus
TYPE_RANK = {b: i for i, b in enumerate(["college", "high_school", "middle_school", "community_center", "senior_center",
                                         "elementary_school", "small_school", "library", "worship"])}


def main():
    z = np.load(WORK / "block_flood.npz")
    keys, F = list(z["keys"]), z["pop"].astype(np.float64)
    bx, by, tract = z["x"], z["y"], z["tract"]
    tr = gpd.read_file(DOCS / "tracts.geojson")
    city = np.array([dict(zip(tr.GEOID.str[5:], tr.place)).get(t, "Unincorporated") for t in tract])
    tract_codes, tract_idx = np.unique(tract, return_inverse=True)
    bgeom = block_shapes(bx, by).geometry.values
    bpoint = shapely.points(bx, by)
    (DOCS / "uncovered").mkdir(parents=True, exist_ok=True)

    def to_lonlat(x, y):
        p = gpd.GeoSeries(gpd.points_from_xy([x], [y]), crs=3310).to_crs(4326).iloc[0]
        return p.x, p.y

    feats = json.load(open(DOCS / "points.json"))["features"]
    cap = json.load(open(DOCS / "capacity.json"))["sites"]
    props = [f["properties"] for f in feats]
    xy = gpd.GeoSeries(gpd.points_from_xy([f["geometry"]["coordinates"][0] for f in feats],
                                          [f["geometry"]["coordinates"][1] for f in feats]), crs=4326).to_crs(3310)
    px, py = xy.x.values, xy.y.values
    pre = np.array([i for i, p in enumerate(props) if p["k"] == "pre" and str(p["id"]) in cap])
    unnamed = {"School", "Community center", "Library", "Place of worship"}
    pot = np.array([i for i, p in enumerate(props) if p["k"] in POTENTIAL and p["n"] not in unnamed])
    pre_cap = np.array([cap[str(props[i]["id"])][0] for i in pre])
    row_of = {int(i): r for r, i in enumerate(shelter_sites()[0])}
    pre_row = np.array([row_of[int(props[i]["id"])] for i in pre])
    pot_row = np.array([row_of[int(props[i]["id"])] for i in pot])

    def distances(tables, mode):
        """Dense site x block network distance (inf where out of range or unreachable) from 14_access.py's tables."""
        D = np.full((len(row_of), len(bx)), np.inf, np.float32)
        D[tables[f"{mode}_site"], tables[f"{mode}_block"]] = tables[f"{mode}_m"]
        return D
    masks = np.array([p["m"] for p in props])
    all_pre = np.array([i for i, p in enumerate(props) if p["k"] == "pre"])
    near_pre = np.hypot(px[pot][:, None] - px[all_pre][None, :], py[pot][:, None] - py[all_pre][None, :]).min(axis=1) < SAME_SITE_M
    type_rank = np.array([TYPE_RANK.get(props[i].get("b"), 99) for i in pot])
    group = np.minimum(type_rank // 5 + (type_rank >= 7), 2)  # 0 colleges/schools/centers, 1 elementary/small, 2 library/worship
    size = json.load(open(DOCS / "site_size.json"))
    size_rank = np.array([{"L": 0, "T": 1, "?": 1, "S": 2}.get(size.get(str(props[i]["id"]), [0, "?"])[1], 1) for i in pot])
    print(f"{len(pre)} pre-identified shelters, {len(pot)} potential sites, {len(bx)} blocks")

    def candidates(near_pot, dry_pot, weights):
        reach = near_pot @ weights
        reach[~dry_pot | near_pre] = 0
        total = weights.sum()
        cx, cy = (bx * weights).sum() / total, (by * weights).sum() / total
        dist = np.hypot(px[pot] - cx, py[pot] - cy)
        step = max(10.0, 0.05 * total)  # residents reached within ~5% count as a tie
        order = np.lexsort((dist, type_rank, size_rank, group, -np.floor(reach / step)))[:TOP]
        return [[int(props[pot[j]]["id"]), int(round(reach[j]))] for j in order if reach[j] >= 1]

    out = {}
    for key in keys:
        fl = F[keys.index(key)]
        m = scenario_mask(key)
        dry_pre = (masks[pre] & m) == 0
        dry_pot = (masks[pot] & m) == 0
        flooded = fl > 0
        tables = load_access(key)
        D_mode = {"walk": distances(tables, "walk"), "drive": distances(tables, "drive")}
        out[key] = {}
        areas = []
        for km in RADII_KM:
            R = km * 1000
            D = D_mode["walk" if km <= 2 else "drive"]
            D_pre, near_pot = D[pre_row].T, (D[pot_row] <= R).astype(np.float32)
            entry = {"a": {}, "u": {}, "c": {}}
            if flooded.any() and dry_pre.any():
                Dd = np.where(dry_pre[None, :], D_pre, np.inf)
                nearest, dist = Dd.argmin(axis=1), Dd.min(axis=1)
                covered = flooded & (dist <= R)
            else:
                nearest, covered = np.zeros(len(fl), int), np.zeros(len(fl), bool)
            assigned = np.bincount(nearest[covered], weights=fl[covered], minlength=len(pre))
            for j in np.flatnonzero(assigned >= 1):
                sid = int(props[pre[j]]["id"])
                entry["a"][sid] = int(round(assigned[j]))
                if assigned[j] > pre_cap[j]:
                    w = np.where(covered & (nearest == j), fl, 0.0).astype(np.float32)
                    entry["c"][sid] = candidates(near_pot, dry_pot, w)
            unc = flooded & ~covered
            for cty in np.unique(city[unc]):
                sel = unc & (city == cty)
                total = fl[sel].sum()
                if total >= MIN_UNCOVERED:
                    w = fl[sel]
                    lon, lat = to_lonlat((bx[sel] * w).sum() / w.sum(), (by[sel] * w).sum() / w.sum())
                    entry["u"][cty] = [int(round(total)), candidates(near_pot, dry_pot, np.where(sel, fl, 0.0).astype(np.float32)),
                                       [round(lon, 5), round(lat, 5)]]
            for cty in np.unique(city[unc]):
                sel = np.flatnonzero(unc & (city == cty))
                if fl[sel].sum() < 0.5:
                    continue
                merged = shapely.union_all(shapely.buffer(bgeom[sel], 25))
                pieces = list(getattr(merged, "geoms", [merged]))
                which = shapely.STRtree(pieces).query(bpoint[sel], predicate="within")
                people = np.bincount(which[1], weights=fl[sel][which[0]], minlength=len(pieces))
                for piece, n in zip(pieces, people):
                    if n >= 0.5:
                        lp = piece.representative_point()
                        areas.append({"kind": "area", "km": km, "city": str(cty), "people": int(round(n)),
                                      "geometry": shapely.simplify(piece, 20)})
                        areas.append({"kind": "label", "km": km, "city": str(cty), "people": int(round(n)), "geometry": lp})
            out[key][km] = entry
        path = DOCS / "uncovered" / f"{key}.geojson"
        path.unlink(missing_ok=True)
        if areas:
            gpd.GeoDataFrame(areas, geometry="geometry", crs=3310).to_crs(4326).to_file(path, driver="GeoJSON", COORDINATE_PRECISION=5)
    path = DOCS / "capacity_gaps.json"
    path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1e3:.0f} KB)")
    for key in ("b2_r0_c0", "b3_r0_c0"):
        e = out[key][2]
        names = {p["id"]: p["n"] for p in props}
        print(f"\n{key} @2 km: over capacity at 20%:",
              [names[int(k)] for k, v in e["a"].items() if v * 0.2 > cap[str(k)][0]],
              "| gaps:", {c: v[0] for c, v in e["u"].items()})
        for sid, cands in list(e["c"].items())[:2]:
            print(f"  near {names[int(sid)]}: {[(names[i], r) for i, r in cands]}")


if __name__ == "__main__":
    main()
