# Architecture Plan & Data Checklist

Alameda County flood-risk dashboard, built for near-term emergency response
during the 2026–27 El Niño. The focus is **near-term**: the coming weeks to
months, starting fall 2026.

## 1. Framing

- NOAA's ENSO update of 10 Sep 2026 gives a >90% chance of a very strong
  El Niño, and a 75% chance that Oct–Dec ranks among the strongest on
  record. The warming is concentrated in the eastern Pacific, like 1982–83
  and 1997–98.
- **The main early-season driver is Bay water level.** Strong El Niños raise West
  Coast sea level for months before the heavy rain arrives. King tides
  (around Nov and Dec) plus that rise plus storm surge can flood the
  shoreline with little rain.
- **The second driver is early-season atmospheric rivers.** Example: 24 Oct
  2021. These cause urban and creek flooding. Dry early-season soils reduce
  runoff in the hills, but paved areas flood regardless.
- **Compound flooding:** rain falling during a high tide. Storm drains that
  empty into the Bay can't drain, so low inland areas pond.
- The heaviest El Niño rain is most likely **Jan–Mar 2027**. Design so the
  dashboard is still useful then; hillside layers can be added for that
  period.
- **Audience is emergency response.** The questions it should answer: who
  floods, who can't leave on their own (no car, 65+, disability, care
  facilities), which roads and crossings are cut, and where people could
  go.

## 2. Dashboard controls

| Control | Values | Data behind it |
|---|---|---|
| **Bay water level** (slider) | Normal · +1 ft · +2 ft · +3 ft · +4 ft above normal high tide (MHHW) | NOAA sea-level-rise maps at 1–4 ft (ART may be added later as a cross-check) |
| **Rain / creek flooding** (slider) | None · 1%-per-year ("100-yr") · 0.2%-per-year ("500-yr") | FEMA NFHL flood zones |
| **Rain during high tide** (toggle) | Off / On | Turns on the low-lying areas the Bay level would cover but that aren't directly connected to the Bay (NOAA `_low_` polygons). This is a proxy for tide-blocked drainage, not a model. Optional for the first version. |
| **Socioeconomic overlay** (choose one) | No car · 65+ · Disability · Poverty · Median income · Limited English · Renters | ACS tract data, shown as a choropleth |
| **Points** (toggles) | Critical facilities · Potential shelters · Cut roads and crossings | See checklist |

Slider labels should give everyday reference points. Each needs checking
against NOAA tide station 9414750 (Alameda) before it goes on the page:

- **+1 ft:** a typical king tide.
- **+2 ft:** a king tide plus the El Niño sea-level boost plus a moderate
  storm surge.
- **+3 ft:** roughly the historic-record Bay water levels from the 1982–83
  El Niño.
- **+4 ft:** a stress test beyond anything recorded.

### Summary panel (updates live)
- Number of people, households, and housing units in the flooded area
- People in vulnerable groups: households without a car, people 65+, people
  with a disability, people in poverty, households with limited English
- Number of critical facilities flooded, by type
- Potential shelters that stay dry, and road segments and crossings cut
- A table of the top tracts by affected households without a car

## 3. Architecture

```
alameda-flood-map/
├── PLAN.md
├── pipeline/                # Python, run offline; outputs are committed
│   ├── 01_download.py       # fetch raw sources → data/raw/ (gitignored)
│   ├── 02_flood_layers.py   # clip and simplify flood layers → docs/data/flood/
│   ├── 03_census.py         # tract indicators + flooded shares → docs/data/
│   └── 04_points.py         # (planned) facilities, shelter candidates, crossings
├── data/
│   ├── raw/                 # gitignored, large
│   └── work/                # gitignored, full-precision intermediates
└── docs/                    # the website, served by GitHub Pages
    ├── index.html, style.css, app.js
    └── data/                # compact GeoJSON / JSON the page loads
```

### Offline pipeline (Python)
- **Setup:** the machine only has Apple's Python 3.9 with no geospatial
  libraries. Install [uv](https://docs.astral.sh/uv/) (a single binary,
  installed with a curl script, no Homebrew needed). Then create a Python
  3.12 virtual environment with geopandas, pyogrio, shapely, requests, and
  pandas.
- **Coordinates:** work in projected CRS EPSG:3310 (California Albers) for
  area math, and output EPSG:4326 with coordinates rounded to 5 decimals.
- **Flood layers:**
  - Clip each layer to the county boundary.
  - Dissolve so there is one flood polygon per step: each Bay level, each
    FEMA zone, and the disconnected areas for each Bay level.
  - Simplify with about 5–10 m tolerance.
  - Target file size is under about 1–2 MB per layer.
- **Who is affected (block-level weighting):**
  - Intersect 2020 Census **blocks** with each flood layer to get each
    block's flooded share of area.
  - flooded people in a block = block population × flooded share.
  - Add these up by tract to get each tract's flooded share of population.
  - Apply that share to each tract's ACS counts, e.g. zero-car households ×
    flooded share.
  - This is much more accurate than weighting whole tracts by area, because
    shoreline tracts are often partly marsh or industrial land.
- **Scenario combinations:**
  - 5 Bay levels × 3 rain levels × 2 compound settings = **30 combinations**.
  - For each combination, write the union of the layers it uses, and that
    union's flooded share for every tract.
  - Output `scenarios.json` as `{combo_id: {tract_geoid: flooded_pop_share}}`.
  - The browser multiplies by tract attributes, so there's no geometry math
    on the client.
- **Points:** for each facility, crossing, and shelter, precompute the
  lowest scenario that floods it. The browser then just filters on that
  value.

### Front end
- **MapLibre GL JS** loaded from a CDN (WebGL, so it handles many polygons
  smoothly and makes layer styling easy).
- **Basemap:** OpenFreeMap "Positron" (free, no API key). CARTO's free raster
  tiles now require a key. The map is always light, even when the viewer's
  system is in dark mode (the side panel follows the system setting).
- **Plain JS with no build step,** since Node isn't installed. The page
  fetches its data files from `docs/data/`.
- **Run locally:** `python3 -m http.server 8765 --directory docs`, then open
  http://localhost:8765. URL parameters set the scenario, e.g.
  `?b=3&r=100&c=1&v=nocar` (Bay level, FEMA zone, low-lying on/off, shading).
- **Hosting:** public GitHub Pages, serving from the `docs/` folder. The
  data total should stay small (a few MB) so the page loads fast on phones.
- **Required wording on the page:**
  - "Potential shelter sites — not official, not verified open"
  - "Planning tool, not an official forecast or evacuation order"
  - Data dates and sources

## 4. Data checklist

Status key: ☐ to do, ⚠ verify availability or licensing first.

### Flood hazard
- ☐ **FEMA National Flood Hazard Layer (NFHL)**: Alameda County (FIPS
  06001) from the FEMA Map Service Center. Layer `S_FLD_HAZ_AR`:
  - 1% zone: `FLD_ZONE` in {A, AE, AH, AO, VE}.
  - 0.2% zone: `ZONE_SUBTY` = "0.2 PCT ANNUAL CHANCE FLOOD HAZARD".
- ✅ **NOAA sea-level-rise maps — primary source for the Bay water level
  slider** (`CA_SFBay_slr_final_dist.gpkg`, 155 MB, downloaded by
  `noaa_slr`): half-foot steps from 0 to 10 ft above MHHW. `_slr_` layers
  are ocean-connected flooding and `_low_` layers are isolated low-lying
  areas that may flood. Inside the county at +1 ft: 45 km² connected and
  75 km² low-lying; at +4 ft: 144 and 11 km². NOAA is a "bathtub" model and
  may overstate flooding behind levees and shoreline protection; the page
  should say so. Read the NOAA methods document on how it treats levees.
- ⏸ **Adapting to Rising Tides (BCDC) — optional cross-check, parked.**
  Downloaded to `data/raw/art/` (12, 24, 36, 52 in; CC-BY, credit
  required) via the Caltrans-hosted service
  `geodata.dot.ca.gov/.../DEA_BCDC_polygon_SLR/FeatureServer`. Known
  difficulties:
  - Geometries are huge (tens of MB per feature), and clipping or combining
    them in geopandas is too slow (a single layer didn't finish in 9+
    minutes even after simplifying). Needs a different approach, such as
    rasterizing or simplifying inside GDAL.
  - The 48-in layer is empty in this service (52 in is populated).
  - Polygons carry only a depth bin (`DEPTH_FT`), with no connected/
    disconnected flag.
  - The same service family has Road/Rail layers (`DEA_BCDC_SLR`) at 12–108
    in, which could feed the cut-roads layer later.
  - Bring it in after v1 if there's time, mainly to compare against NOAA.
- ☐ **NOAA tide stations:**
  - 9414750 Alameda (primary), 9414290 San Francisco, 9414523 Redwood City.
  - Download the MHHW datum and the record high water to calibrate slider
    labels.
  - Download the 2026–27 tide predictions to find the king tide dates.
- No live water-level feed. Instead, link to the NOAA tide gauge page for
  9414750 and to NWS San Francisco Bay Area, whose coastal flood advisories
  are the authoritative source during storms.

### Census
- ☐ **Tract boundaries:** Census cartographic boundary file, CA tracts
  (`cb_2024_06_tract_500k`), filtered to county 001.
- ☐ **2020 Census block boundaries and populations** (TIGER/Line tabblock20
  + P1 total population, H1 housing units) for the block-level weighting.
- ☐ **ACS 5-year (2020–2024)** tract tables via the Census API. A free API
  key is **required** (keyless requests are redirected to a "missing key"
  page). Store it in `.env` as `CENSUS_API_KEY` (gitignored).
  - B01003 total population; B11001 households
  - **B25044 vehicles available by tenure** (zero-vehicle households, owners
    vs renters)
  - B01001 sex by age (sum the 65+ groups)
  - B18101 disability status by age
  - B17001 poverty status
  - B19013 median household income
  - C16002 limited-English-speaking households
  - B25003 tenure (renter share)
- ⚠ Small-tract margins of error: store the MOEs and grey out tracts whose
  estimates are unreliable.

### Critical facilities (emergency response)
- ⚠ **Hospitals and skilled nursing facilities:** California HCAI licensed
  facility list (CHHS Open Data), which includes coordinates.
- ⚠ **Residential care for the elderly:** CA Dept of Social Services
  Community Care Licensing facility data. It may only have addresses, which
  would need geocoding (Census geocoder, free batch).
- ⚠ **Dialysis centers:** CMS Dialysis Facility listing (addresses, so
  geocode).
- ☐ **Fire stations and police:** OpenStreetMap via the Overpass API
  (`amenity=fire_station|police`).

### Potential shelters (clearly labeled unofficial)
- ☐ **Public schools:** CA Dept of Education Public Schools database (has
  lat/long). Keep active schools only.
- ☐ **Community centers and libraries:** OpenStreetMap
  (`amenity=community_centre|library`).
- ☐ **Places of worship:** OpenStreetMap (`amenity=place_of_worship`). Show
  these as a separate, **lower-confidence** category with a distinct marker
  and their own toggle, since they're private sites with no shelter
  agreement.
- OpenStreetMap data is ODbL licensed, so the page must credit it.
- Rule: a site is a "potential shelter" in a scenario only if it stays dry
  in that scenario, which is computed per point.

### Roads and access
- ☐ **Roads:** OpenStreetMap drivable roads, or TIGER/Line roads. Intersect
  them with each scenario to get **cut road segments**.
- ☐ **Hand-curated crossings,** each tested against the scenarios:
  - The links to the island of Alameda and to Bay Farm Island: Posey and
    Webster tubes; Park St, Fruitvale, High St, and Bay Farm bridges; Doolittle Dr.
  - Key underpasses and the I-880 low points.
- Skip true network reachability analysis in v1. Flag cut segments and
  crossings instead.

### Deferred
- Landslide and debris-flow susceptibility (California Geological Survey).
  Add for the Jan–Mar 2027 period as a "hillside access" layer.
- Tsunami zones. They're unrelated to El Niño, so at most an "other
  hazards" toggle later.

## 5. Build phases

1. **Setup.** Install uv and the Python environment; add `.gitignore` for
   `data/raw/`. *(Sonnet)*
2. **Flood layers.** ✅ Done (`pipeline/02_flood_layers.py`, takes about 30
   minutes because the NOAA polygons are large, so don't rerun casually).
   Produces 10 component layers: NOAA connected and low-lying at +1 to +4
   ft, and FEMA 100-yr and 500-yr. Full-precision copies go to
   `data/work/flood_full.gpkg` (gitignored) and simplified web copies
   (about 7 MB total) to `data/build/flood/`. The 30 scenario unions are
   built on the fly in phase 3, where they're needed for the population
   math; the page draws the component layers stacked. ART is parked.
   Follow-up: shrink the web files if load time matters.
3. **Census and weighting.** ✅ Done (`pipeline/03_census.py`, runs in
   ~15 s). Block-level flooded shares → tract shares → ACS counts, using a 10 m grid
   overlay instead of polygon intersection. Outputs `data/build/tracts.geojson`
   (ACS counts, %, low-reliability flags, income) and
   `data/build/scenarios.json` (people and homes share per tract for all 30
   scenarios). Validated: 378/378 tracts joined, block vs ACS tract
   population correlation 0.98, totals never decrease as scenarios worsen.
   Finding: FEMA zones include Bay coastal flooding, so most Bay-level
   flooding already sits inside the FEMA 100-yr zone. Label the FEMA slider
   as official flood zones, not just rain/creek flooding. *(Opus)*
4. **Map UI.** ✅ Done (`docs/`). Bay water level slider, FEMA zone buttons,
   low-lying toggle, eight shading options (orange sequential ramp, quantile
   classes), live summary of people, homes, and vulnerable groups versus the
   county, a most-affected-neighborhoods list, tract popups with
   margin-of-error notes, and a collapsible legend. Works on phones (map
   pinned above the controls). Tested in headless Chrome; the numbers on the
   page match the precomputed scenarios. Not yet done: keyboard arrow-key
   behavior on button groups, and testing in Safari and Firefox. The page
   deliberately doesn't mention El Niño or specific months. *(Sonnet)*
5. **Points and roads.** ✅ Done (`pipeline/04_points.py`, `05_roads.py`).
   1,468 sites in `docs/data/points.json`, each tagged with a bitmask of the
   flood layers that reach it: 22 hospitals, 50 nursing/assisted living,
   6 dialysis, 100 fire and 28 police stations, 362 public schools, 110
   community centers, 97 libraries, 680 places of worship. Flooded major
   road pieces per layer in `docs/data/roads/` and per-scenario kilometers
   and top roads in `roads_summary.json` (bridges, viaducts, and tunnels
   excluded). Page shows facility and shelter markers (flooded facilities in
   red, only dry shelters shown), flooded roads, and an Emergency response
   summary. **Known gap: OpenStreetMap undercounts care homes and dialysis
   centers badly** (50 and 6, versus hundreds and about 60 in reality).
   Better sources, if wanted: CA Community Care Licensing (care homes),
   CMS dialysis listing, and HCAI, all address-based so they need
   geocoding (Census batch geocoder, free). Overpass was flaky: the area
   query timed out, so downloads use a bounding box and are clipped to the
   county afterward. *(Sonnet)*
   **Key shelters** (`06_key_shelters.py`, `shelter_reach.json`): for each
   scenario, flooded residents and flooded residents without a car within
   1 km and 2 km of each site (block centers, straight-line). Key = dry
   sites with at least 100 nearby affected residents (no-car residents count
   twice), top 3 per city; others are faded. The page has a 1 km / 2 km
   picker and a ranked list. **Rough size tiers** come from site type only
   (`t` in points.json): larger = high schools and K-12; medium = elementary
   and middle schools and community centers; smaller = libraries and
   continuation, alternative, and special-ed schools; varies = places of
   worship. Possible refinement: school enrollment and OSM building
   footprints as better capacity proxies (not yet checked for availability).
   **Pre-identified shelters** (`07_geocode_shelters.py`): 75 sites from a
   list supplied privately (kept in gitignored `data/raw/shelters/`; do not
   name the source in public files). Located by matching our point data,
   OpenStreetMap search, and Census-geocoded addresses
   (`data/raw/shelters/overrides.csv`). Shown with a house marker, red when
   flooded, with their own panel section. Run order: `04` → `07` → `04` →
   `06` → `08`.
   **Site size** (`08_footprints.py`, `site_size.json`): main building of
   each shelter site from OSM building outlines (campus outline, else the
   containing or nearest building; a gym if one is tagged and big enough).
   About 20% of sites are unreliable (host buildings like a library in a
   mall, missed gyms, no match), so they are flagged, and sizes are shown
   only as larger / typical / smaller than other sites of the same type,
   never as people counts. **Assumed capacity per site type** goes in
   `docs/data/capacity.json` (all null until provided); the page shows it
   automatically once filled in.
   **Official facilities** (`09_official_facilities.py`): hospitals, care
   facilities, and dialysis now come from CDPH licensed facilities (with
   coordinates) and CDSS Community Care Licensing (assisted living and adult
   residential care, May 2025, located with the Census batch geocoder). 585
   care facilities (~17,300 licensed residents), 24 in-center dialysis
   clinics, 20 hospitals, replacing the OpenStreetMap versions.
   **Capacity** (`10_capacity.py`, `capacity.json`): surveyed overnight and
   evacuation capacity for the 75 pre-identified shelters (from a privately
   shared survey file kept in gitignored `data/raw/shelters/surveyed.csv`;
   no names, emails, or source in public files). Other sites show the median
   overnight capacity of surveyed sites of the same type (types with 4+
   surveyed sites); leave-one-out error is ~27% median. Footprints did not
   improve the estimate, so they are used only for size classes. No estimate
   yet for elementary schools, libraries, or small schools.
   **Capacity gaps** (`11_capacity_gaps.py`, `capacity_gaps.json`): for each
   scenario and distance, flooded residents go to the nearest dry
   pre-identified shelter in range; the page applies a shelter-use share
   (10/20/50/100%, default 20%, a placeholder pending expert input) and lists
   over-capacity shelters (red ring on the map), cities with no
   pre-identified shelter in range, and nearby dry potential sites to
   contact (excluding unnamed sites and sites within 250 m of a
   pre-identified shelter; ranked by residents reached, then larger types
   and buildings).
   Uncovered areas are drawn in dashed purple: only the census blocks whose
   flooded residents have no dry pre-identified shelter in range (straight
   line), from `docs/data/uncovered/<scenario>.geojson`. Every shaded piece
   has its own label ("est. need ~N residents" or "fewer than 5"); pieces
   under 1 estimated person are not shaded. Below zoom 11 the pieces are
   hidden and each city gets one summary label instead.
   **Road-network access (cut-off areas, travel distance) is parked** for a
   planning session: draft in gitignored `data/work/parked_road_network/`,
   full drivable road download in `data/raw/osm/all_roads.json`.
   **Full run order:** `09` → `04` → `07` → `04` → `06` → `08` → `10` → `11`.
6. **Polish and share.** Disclaimers, sources, mobile layout, bundling,
   GitHub Pages if needed. *(Sonnet)*

**Getting it in front of people quickly:** phases 1–4 produce a
usable shoreline-flooding and vulnerability map and should come first.
Phases 5–6 add the emergency-response detail.

## 6. Open questions

- ~~Single file or URL?~~ **Decided: public GitHub Pages URL.** Page text
  frames the analysis as "near-term" and doesn't name specific months.
- ~~Live tide anomaly?~~ **Decided: no.** Link to NOAA and NWS instead.
- ~~Places of worship?~~ **Decided:** a separate, lower-confidence shelter
  category.
