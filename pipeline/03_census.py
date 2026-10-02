"""Tract indicators from ACS, and each tract's flooded share of people and homes per scenario.

Method: blocks, county land, and flood layers are burned onto a common 10 m grid. A block's
flooded share is its flooded land cells / its land cells; flooded people = 2020 block population x
that share (homes use 2020 housing units). Summing blocks gives each tract's flooded share, which
the page multiplies by the tract's ACS counts. This assumes people are spread evenly within a block
and that flooded residents look like their tract on each ACS indicator.

Outputs: docs/data/tracts.geojson, docs/data/scenarios.json
"""
import json
import math
import time
import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio.features
from rasterio.transform import from_origin

from common import CRS, DOCS as BUILD, FLOOD, RAW, WORK
CELL = 10  # meters
BAY_LEVELS = [0, 1, 2, 3, 4]
RAIN = {0: None, 100: "fema_100yr", 500: "fema_500yr"}
CV_UNRELIABLE = 0.4  # coefficient of variation above which an ACS count is flagged

# name: (table, estimate cells, universe cell, weight). weight: "pop" = people, "hu" = households
INDICATORS = {
    "pop": ("B01003", ["001"], None, "pop"),
    "hh": ("B11001", ["001"], None, "hu"),
    "nocar": ("B25044", ["003", "010"], "001", "hu"),
    "age65": ("B01001", ["020", "021", "022", "023", "024", "025", "044", "045", "046", "047", "048", "049"], "001", "pop"),
    "disab": ("B18101", ["004", "007", "010", "013", "016", "019", "023", "026", "029", "032", "035", "038"], "001", "pop"),
    "pov": ("B17001", ["002"], "001", "pop"),
    "lep": ("C16002", ["004", "007", "010", "013"], "001", "hu"),
    "rent": ("B25003", ["003"], "001", "hu"),
}


def log(t0, msg):
    print(f"{time.time() - t0:6.1f}s  {msg}", flush=True)


def load_acs():
    frames = []
    for table in {spec[0] for spec in INDICATORS.values()} | {"B19013"}:
        rows = json.load(open(RAW / "census" / f"acs_{table}.json"))
        df = pd.DataFrame(rows[1:], columns=rows[0]).set_index("tract")
        frames.append(df[[c for c in df.columns if c.startswith(f"{table}_") and c.endswith(("E", "M"))]])
    acs = pd.concat(frames, axis=1).apply(pd.to_numeric)
    return acs.where(acs >= 0)  # Census uses large negative sentinels for "not available"


def tract_indicators(acs):
    out = pd.DataFrame(index=acs.index)
    for name, (table, cells, universe, _) in INDICATORS.items():
        est = acs[[f"{table}_{c}E" for c in cells]].sum(axis=1, min_count=1)
        moe = np.sqrt((acs[[f"{table}_{c}M" for c in cells]] ** 2).sum(axis=1, min_count=1))
        out[name] = est.round().astype("Int64")
        cv = (moe / 1.645) / est.where(est > 0)
        out[f"{name}_lowrel"] = (cv > CV_UNRELIABLE).astype(int)
        if universe:
            uni = acs[f"{table}_{universe}E"]
            out[f"{name}_u"] = uni.round().astype("Int64")
            out[f"{name}_pct"] = (100 * est / uni.where(uni > 0)).round(1)
    out["income"] = acs["B19013_001E"].round().astype("Int64")
    return out


def load_blocks():
    b = gpd.read_file(f"zip://{RAW / 'census' / 'blocks_alameda.zip'}").to_crs(CRS)
    rows = json.load(open(RAW / "census" / "block_pop_2020.json"))
    p = pd.DataFrame(rows[1:], columns=rows[0])
    p["GEOID20"] = p.state + p.county + p.tract + p.block
    p = p.rename(columns={"P1_001N": "pop", "H1_001N": "hu"})[["GEOID20", "pop", "hu"]]
    p[["pop", "hu"]] = p[["pop", "hu"]].astype(int)
    b = b.merge(p, on="GEOID20", how="left", validate="1:1")
    assert b["pop"].notna().all(), "block without population record"
    b = b[(b["pop"] > 0) | (b["hu"] > 0)].reset_index(drop=True)
    b["tract"] = b.GEOID20.str[5:11]
    return b


def main():
    t0 = time.time()
    acs = load_acs()
    ind = tract_indicators(acs)
    blocks = load_blocks()
    log(t0, f"{len(blocks)} populated blocks, {blocks['pop'].sum():,} people, {blocks['hu'].sum():,} housing units")

    tracts = gpd.read_file(f"zip://{RAW / 'census' / 'tracts_ca.zip'}")
    tracts = tracts[tracts.COUNTYFP == "001"].to_crs(CRS)
    land_geom = tracts.union_all()

    minx, miny, maxx, maxy = (np.array(land_geom.bounds) + [-50, -50, 50, 50]).tolist()
    width, height = math.ceil((maxx - minx) / CELL), math.ceil((maxy - miny) / CELL)
    transform = from_origin(minx, maxy, CELL, CELL)

    def burn(shapes, dtype="uint8"):
        return rasterio.features.rasterize(shapes, out_shape=(height, width), transform=transform, fill=0, dtype=dtype)

    land = burn([(land_geom, 1)]).astype(bool)
    block_id = burn(((g, i + 1) for i, g in enumerate(blocks.geometry)), dtype="int32")
    log(t0, f"grid {width}x{height} at {CELL} m")

    layer_names = [f"{k}_{ft}ft" for ft in BAY_LEVELS[1:] for k in ("bay", "low")] + ["fema_100yr", "fema_500yr"]
    keep = land & (block_id > 0)
    bid = block_id[keep]
    n = len(blocks) + 1
    land_cells = np.bincount(bid, minlength=n)[1:]

    # Blocks too small or too far outside the land outline to own a cell: use their interior point instead.
    tiny = np.flatnonzero(land_cells == 0)
    pts = blocks.geometry.iloc[tiny].representative_point()
    rows, cols = rasterio.transform.rowcol(transform, pts.x.values, pts.y.values)
    rows, cols = np.clip(rows, 0, height - 1), np.clip(cols, 0, width - 1)

    masks, at_pts = {}, {}
    for name in layer_names:
        full = burn([(gpd.read_file(FLOOD, layer=name).geometry.iloc[0], 1)]).astype(bool)
        masks[name], at_pts[name] = full[keep], full[rows, cols]
    log(t0, f"flood layers burned; {len(tiny)} blocks with no land cell "
            f"({blocks['pop'].iloc[tiny].sum():,} people) use point sampling")

    tract_pop = blocks.groupby("tract")["pop"].sum()
    tract_hu = blocks.groupby("tract")["hu"].sum()
    scenarios, summary = {}, []
    block_keys, block_flooded = [], []
    for b in BAY_LEVELS:
        for r, rain_layer in RAIN.items():
            for c in (0, 1):
                m = np.zeros(bid.shape, bool)
                pm = np.zeros(len(tiny), bool)
                parts = ([f"bay_{b}ft"] if b else []) + ([f"low_{b}ft"] if b and c else []) + ([rain_layer] if rain_layer else [])
                for name in parts:
                    m |= masks[name]
                    pm |= at_pts[name]
                flooded = np.bincount(bid[m], minlength=n)[1:]
                share = np.divide(flooded, land_cells, out=np.zeros(len(blocks)), where=land_cells > 0)
                share[tiny] = pm
                block_keys.append(f"b{b}_r{r}_c{c}")
                block_flooded.append((blocks["pop"].values * share).astype(np.float32))
                fp = (blocks["pop"] * share).groupby(blocks.tract).sum()
                fh = (blocks["hu"] * share).groupby(blocks.tract).sum()
                ps = (fp / tract_pop.where(tract_pop > 0)).fillna(0)
                hs = (fh / tract_hu.where(tract_hu > 0)).fillna(0)
                key = f"b{b}_r{r}_c{c}"
                scenarios[key] = {
                    f"06001{t}": [round(ps[t], 4), round(hs[t], 4)]
                    for t in ps.index if ps[t] >= 0.0005 or hs[t] >= 0.0005
                }
                nocar = (ind["nocar"].astype(float).reindex(hs.index).fillna(0) * hs).sum()
                summary.append((key, int(fp.sum()), int(fh.sum()), int(nocar), len(scenarios[key])))
    log(t0, "scenarios computed")

    cent = blocks.geometry.representative_point()
    WORK.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(WORK / "block_flood.npz", keys=np.array(block_keys), pop=np.vstack(block_flooded),
                        x=cent.x.values, y=cent.y.values, tract=np.array(blocks.tract.tolist(), dtype="U6"))

    BUILD.mkdir(parents=True, exist_ok=True)
    meta = {
        "method": "10 m grid overlay of 2020 Census blocks with flood layers; tract share = flooded block "
                  "population (or housing units) / tract total. Apply shares to ACS 2020-2024 tract counts.",
        "share_fields": ["people_share", "homes_share"],
        "weights": {k: v[3] for k, v in INDICATORS.items()},
    }
    (BUILD / "scenarios.json").write_text(json.dumps({"meta": meta, "scenarios": scenarios}, separators=(",", ":")))

    t = tracts.merge(ind, left_on="TRACTCE", right_index=True, how="left", validate="1:1")
    t["pop20"] = t.TRACTCE.map(tract_pop).fillna(0).astype(int)
    t["hu20"] = t.TRACTCE.map(tract_hu).fillna(0).astype(int)

    places = gpd.read_file(f"zip://{RAW / 'census' / 'places_ca.zip'}").to_crs(CRS)[["NAME", "geometry"]]
    pts = gpd.GeoDataFrame(geometry=t.geometry.representative_point(), index=t.index, crs=CRS)
    joined = gpd.sjoin(pts, places, how="left", predicate="within")
    t["place"] = joined["NAME"].groupby(level=0).first().reindex(t.index).fillna("Unincorporated")

    t = t[["GEOID", "NAMELSAD", "place", "pop20", "hu20", *ind.columns, "geometry"]]
    t = t.rename(columns={"NAMELSAD": "name"}).to_crs(4326)
    out = BUILD / "tracts.geojson"
    out.unlink(missing_ok=True)
    t.to_file(out, driver="GeoJSON", COORDINATE_PRECISION=5)

    print(f"\n{'scenario':<12}{'people':>10}{'homes':>9}{'no-car hh':>11}{'tracts':>8}")
    for row in summary:
        print(f"{row[0]:<12}{row[1]:>10,}{row[2]:>9,}{row[3]:>11,}{row[4]:>8}")
    print(f"\ntracts.geojson {out.stat().st_size / 1e6:.2f} MB | scenarios.json "
          f"{(BUILD / 'scenarios.json').stat().st_size / 1e6:.2f} MB")
    log(t0, "done")


if __name__ == "__main__":
    main()
