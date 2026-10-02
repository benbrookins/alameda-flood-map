# Alameda County Flood Risk Explorer

An interactive map of near-term flood scenarios in Alameda County, CA: who lives in flooded areas, which critical
facilities and shelters are affected, and where shelter capacity falls short.

Live site: https://benbrookins.github.io/alameda-flood-map/

This is a planning tool, not an official forecast, warning, or evacuation order.

## Layout

```
pipeline/   Python scripts that build the data (run offline; outputs are committed)
docs/       The website (GitHub Pages serves this folder)
  index.html, style.css, app.js
  data/     Data files the page loads
data/       Downloads and intermediates (gitignored)
```

## Running the site locally

```
python3 -m http.server 8765 --directory docs
```

Then open http://localhost:8765. The page needs internet access for the basemap and map library.

## Rebuilding the data

The pipeline uses [uv](https://docs.astral.sh/uv/) and Python 3.12 (`uv sync` installs dependencies). The Census
API step needs a free key in `.env` as `CENSUS_API_KEY`. Run each step with `uv run python pipeline/<script>.py`:

| Step | Script | What it does |
|---|---|---|
| 1 | `01_download.py` | Downloads source data into `data/raw/` |
| 2 | `02_flood_layers.py` | Clips NOAA sea-level and FEMA flood layers to the county; only builds missing layers (`--rebuild` for all, ~30 min) |
| 3 | `03_census.py` | Tract indicators and flooded share of residents for each scenario |
| 4 | `09_official_facilities.py` | Hospitals, care facilities, and dialysis clinics from state licensing lists |
| 5 | `04_points.py` | Facilities and shelter sites with the flood layers that reach them |
| 6 | `07_geocode_shelters.py`, then `04_points.py` again | Locates pre-identified shelters (needs gitignored inputs) |
| 7 | `05_roads.py` | Major roads under water per scenario |
| 8 | `06_key_shelters.py` | Flooded residents near each shelter site |
| 9 | `08_footprints.py` | Building-size class for each shelter site |
| 10 | `10_capacity.py` | Shelter capacity (needs gitignored inputs) |
| 11 | `11_capacity_gaps.py` | Shelter capacity gaps and uncovered areas |

Shared paths and helpers are in `pipeline/common.py`, including the list of Bay water levels (`BAY_LEVELS`). To add a level: add it there, append its two layers to `LAYERS` (new bitmask bits), add it to `BAY_LEVELS`, `BAY_HINTS`, `BAY_BIT`, and `LOW_BIT` in `docs/app.js` and to the slider in `docs/index.html`, then rerun from step 2. `12_outreach_list.py` writes a private outreach spreadsheet to `data/work/`. Sources and methods are described on the page under
"About these numbers".
