"""Clip, repair, and simplify flood layers to Alameda County.

Outputs:
  data/work/flood_full.gpkg      full precision, EPSG:3310 (for the population math; gitignored)
  docs/data/flood/<name>.geojson simplified, EPSG:4326 (for the web page)

Layers: bay_{1..4}ft (ocean-connected), low_{1..4}ft (isolated low-lying areas),
fema_100yr (1% annual chance), fema_500yr (0.2% zone plus the 1% zone).
"""
import time
import geopandas as gpd
import shapely

from common import CRS, DOCS, RAW, WORK, county_land as county_outline

WEB = DOCS / "flood"
LEVELS_FT = [1, 2, 3, 4]
SIMPLIFY_M = 8
MIN_AREA_M2 = 500  # drop specks from the web copy only
FEMA_1PCT_ZONES = {"A", "AE", "AH", "AO", "AR", "A99", "V", "VE"}


def valid(geom):
    # make_valid is very slow even on valid input, so only repair what's broken
    return geom if shapely.is_valid(geom) else shapely.make_valid(geom)


def valid_all(geoms):
    geoms = geoms.copy()
    bad = ~shapely.is_valid(geoms)
    if bad.any():
        geoms[bad] = shapely.make_valid(geoms[bad])
    return geoms


def county_land():
    land = county_outline()
    return land, tuple(gpd.GeoSeries([land], crs=CRS).to_crs(4326).total_bounds)

def clip_union(gdf, county):
    geoms = valid_all(gdf.geometry.values)
    return valid(valid(shapely.union_all(geoms)).intersection(county))


def web_copy(geom, name):
    g = gpd.GeoDataFrame(geometry=[geom], crs=CRS).explode(index_parts=False)
    g = g[g.area >= MIN_AREA_M2]
    g["geometry"] = valid_all(shapely.simplify(g.geometry.values, SIMPLIFY_M))
    g = g[~g.is_empty].dissolve().to_crs(4326)
    out = WEB / f"{name}.geojson"
    WEB.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    g.to_file(out, driver="GeoJSON", COORDINATE_PRECISION=5)
    return out.stat().st_size / 1e6


def main():
    t0 = time.time()
    county, bbox = county_land()
    print(f"county land: {county.area / 1e6:.0f} km2")
    layers = {}

    noaa = RAW / "noaa" / "slr_sfbay" / "CA_SFBay_slr_final_dist.gpkg"
    for ft in LEVELS_FT:
        for kind, prefix in (("slr", "bay"), ("low", "low")):
            g = gpd.read_file(noaa, layer=f"CA_SFBay_{kind}_{ft}_0ft", bbox=bbox).to_crs(CRS)
            layers[f"{prefix}_{ft}ft"] = clip_union(g, county)
            print(f"  {prefix}_{ft}ft  {time.time() - t0:.0f}s", flush=True)

    fema = gpd.read_file(RAW / "fema" / "nfhl_flood_hazard.geojson").to_crs(CRS)
    zone = fema.FLD_ZONE.fillna("")
    sub = fema.ZONE_SUBTY.fillna("")
    one = clip_union(fema[zone.isin(FEMA_1PCT_ZONES)], county)
    pt2 = clip_union(fema[(zone == "X") & sub.str.contains("0.2 PCT")], county)
    layers["fema_100yr"] = one
    layers["fema_500yr"] = valid(one.union(pt2))
    print(f"  fema  {time.time() - t0:.0f}s", flush=True)

    WORK.mkdir(parents=True, exist_ok=True)
    gpkg = WORK / "flood_full.gpkg"
    gpkg.unlink(missing_ok=True)
    print(f"\n{'layer':<12}{'km2':>8}{'web MB':>9}")
    for name, geom in layers.items():
        gpd.GeoDataFrame({"name": [name]}, geometry=[geom], crs=CRS).to_file(gpkg, layer=name, driver="GPKG")
        print(f"{name:<12}{geom.area / 1e6:>8.1f}{web_copy(geom, name):>9.2f}")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
