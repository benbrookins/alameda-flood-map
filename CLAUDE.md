# Project: Alameda County Flood Risk Dashboard

## Goal
Build an interactive dashboard/map for a friend showing flood risk in Alameda
County, CA. Core features:
- Map of the county with toggleable/adjustable flood overlays (different flood
  types/scenarios — e.g. FEMA 100-year / 500-year zones, sea-level-rise
  scenarios for the Bay shoreline, tsunami hazard zones)
- Shows how many places/people are affected depending on which flood
  scenario is selected
- Overlay of socioeconomic indicators for the population that would be
  displaced (income, poverty, age 65+, disability, limited English, etc.)
- Overlay of **car ownership** — important variable here since lack of a
  vehicle is a major evacuation-risk factor
- Overlay of potential shelter locations (no official public shelter list
  exists — plan is to use schools/community centers/churches outside flood
  zones as stand-ins, clearly labeled "potential," not official)

## Recommended data sources
- FEMA flood zone maps (100-yr / 500-yr)
- CA "Adapting to Rising Tides" program — sea-level-rise scenarios for Bay
  shoreline
- CA tsunami hazard zones
- US Census ACS at tract level (~380 tracts in Alameda County):
  - Table B25044 — vehicles available per household (car ownership, split by
    renter/owner)
  - Income, poverty, age 65+, disability, limited English tables
- Open datasets for schools/community centers/churches (shelter stand-ins)

## Build approach / model usage guidance
- Use **Sonnet 5** (medium effort) for most of the build (map/overlay code,
  styling, sliders — standard web mapping work, e.g. Leaflet/MapLibre).
- Use **Opus 5.5** only for: initial planning/architecture decisions, and
  getting unstuck on hard bugs or data-join issues. Switch back to Sonnet
  after.
- Avoid "fast mode" — it doesn't save tokens, just runs Opus faster.
- To save tokens: keep raw shapefiles/census files out of the chat context —
  write scripts to clip/simplify data into compact GeoJSON once, offline.
  Precompute each census tract's stats per flood scenario rather than
  recalculating live. Build as a single self-contained HTML page (easy to
  share with the friend, cheap to edit).

## Environment status (already done)
- GitHub CLI (`gh`) installed and authenticated as **benbrookins**
  (repo/workflow/gist/read:org scopes) — this is an Intel Mac, no Homebrew,
  `gh` was installed via direct binary download to `/usr/local/bin/gh`.
- Claude Code CLI installed natively (`curl -fsSL https://claude.ai/install.sh | bash`),
  binary lives at `~/.local/bin/claude` — had to add
  `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` manually since the
  installer didn't do it.
- VS Code + Claude Code extension (anthropic.claude-code) confirmed
  installed and matching CLI version (2.1.286).
- No Node.js/npm installed on this machine.

## Not yet started
- No actual project folder/repo created yet for this dashboard.
- No data downloaded or planning decisions finalized (which flood scenarios,
  exact shelter-site source, final tech stack for the map library) — this was
  the next step before context was moved to this VS Code session.
