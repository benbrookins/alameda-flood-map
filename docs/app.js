'use strict';

// Alameda County Flood Risk Explorer. Plain JS (no build step); data files are made by the Python pipeline.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
};

// ---- configuration ---------------------------------------------------------------------------

const BAY_LEVELS = [0, 1, 2, 2.5, 3, 4];  // slider stops, feet above normal high tide
const BAY_HINTS = {
  0: 'Normal high tide. No Bay flooding in this scenario.',
  1: '+1 ft above normal high tide: about a typical king tide.',
  2: '+2 ft: a king tide with extra high water or a moderate storm surge.',
  2.5: '+2.5 ft: between a moderate and a large storm surge on a high tide.',
  3: '+3 ft: a large storm surge on top of a high tide.',
  4: '+4 ft: a severe stress test beyond recent experience.',
};

// Orange sequential ramp (steps 100, 250, 350, 450, 700). The map is always light, so low = light.
const COLORS = {
  bay: '#2a78d6', low: '#1baf7a', fema: '#3b3a37', edge: '#ffffff', nodata: '#d9d7cf', sel: '#0b0b0b',
  ramp: ['#fbe2d9', '#fcae92', '#f48a63', '#e26331', '#772e10'],
};

// weight: which flooded share applies (pop = people, hu = households). count/uni: tract fields.
const OVERLAYS = [
  { id: 'none', label: 'Nothing' },
  { id: 'nocar', label: 'No car', field: 'nocar_pct', count: 'nocar', uni: 'nocar_u', weight: 'hu', title: 'Households without a car', noun: 'households without a car', unit: '%' },
  { id: 'age65', label: 'Age 65+', field: 'age65_pct', count: 'age65', uni: 'age65_u', weight: 'pop', title: 'Residents age 65 and older', noun: 'residents age 65+', unit: '%' },
  { id: 'disab', label: 'Disability', field: 'disab_pct', count: 'disab', uni: 'disab_u', weight: 'pop', title: 'Residents with a disability', noun: 'residents with a disability', unit: '%' },
  { id: 'pov', label: 'Poverty', field: 'pov_pct', count: 'pov', uni: 'pov_u', weight: 'pop', title: 'Residents below the poverty line', noun: 'residents in poverty', unit: '%' },
  { id: 'lep', label: 'Limited English', field: 'lep_pct', count: 'lep', uni: 'lep_u', weight: 'hu', title: 'Households with limited English', noun: 'households with limited English', unit: '%' },
  { id: 'rent', label: 'Renters', field: 'rent_pct', count: 'rent', uni: 'rent_u', weight: 'hu', title: 'Households that rent', noun: 'renter households', unit: '%' },
  { id: 'income', label: 'Median income', field: 'income', title: 'Median household income', invert: true, unit: '$' },
];
const OV = Object.fromEntries(OVERLAYS.map((o) => [o.id, o]));
const TABLE_ROWS = OVERLAYS.filter((o) => o.count);

const KIND = {
  hospital: 'Hospital', care: 'Care facility', dialysis: 'Dialysis center', fire: 'Fire station', police: 'Police station',
  school: 'School', community: 'Community center', library: 'Library', worship: 'Place of worship', pre: 'Pre-identified shelter',
};
const KIND_PLURAL = {
  hospital: 'Hospitals', care: 'Nursing, assisted living, and care homes', dialysis: 'Dialysis centers', fire: 'Fire stations', police: 'Police stations',
  school: 'Schools', community: 'Community centers', library: 'Libraries', worship: 'Places of worship', pre: 'Pre-identified shelters',
};
const BUCKET = {
  college: 'College or university', high_school: 'High school', middle_school: 'Middle school', elementary_school: 'Elementary school',
  small_school: 'Small or alternative school', community_center: 'Community or recreation center', senior_center: 'Senior center',
  library: 'Library', worship: 'Place of worship',
};
const ST = {
  acute: 'General acute care hospital', psych: 'Psychiatric hospital', snf: 'Skilled nursing facility',
  rcfe: 'Assisted living (residential care for the elderly)', arf: 'Adult residential care home',
  icf: 'Intermediate care facility (developmental disabilities)', clhf: 'Congregate living health facility', dialysis: 'Dialysis clinic',
};
const CAP_UNIT = { hospital: 'beds', care: 'residents', dialysis: 'stations' };
const REL = { L: 'larger than typical', T: 'typical size', S: 'smaller than typical' };
const FAC_KINDS = ['hospital', 'care', 'dialysis', 'fire', 'police'];
const SHELTER_KINDS = ['school', 'community', 'library'];

const KEY_MIN = 100;     // affected residents nearby, with residents without a car counted twice
const KEY_PER_CITY = 3;  // key shelters kept per city
const LIST_N = 12;
const ZOOM_DETAIL = 11;  // below this, uncovered areas show as one label per city instead of shaded pieces

const SHOW_KEYS = { p: 'pre', f: 'fac', s: 'shelter', w: 'worship', r: 'roads' };
const POINT_LAYERS = ['pts-fac', 'pts-fac-bad', 'pts-shelter', 'pts-shelter-key', 'pts-worship', 'pts-worship-key', 'pts-pre', 'pts-pre-bad'];
const COUNTY_BOUNDS = [[-122.36, 37.44], [-121.46, 37.92]];
const REGIONS = [
  { label: 'Full county', bounds: COUNTY_BOUNDS },
  { label: 'Berkeley–Oakland–Alameda', bounds: [[-122.34, 37.70], [-122.16, 37.91]] },
  { label: 'San Leandro–Hayward', bounds: [[-122.24, 37.60], [-122.02, 37.74]] },
  { label: 'Fremont–Newark–Union City', bounds: [[-122.15, 37.46], [-121.90, 37.62]] },
  { label: 'Tri-Valley', bounds: [[-122.0, 37.60], [-121.66, 37.76]] },
  { label: 'Fit to flooding', flood: true },
];

// ---- state (mirrored in the URL) -------------------------------------------------------------

const q = new URLSearchParams(location.search);
const S = {
  bay: BAY_LEVELS.includes(+q.get('b')) ? +q.get('b') : 0,
  rain: [0, 100, 500].includes(+q.get('r')) ? +q.get('r') : 0,
  low: q.get('c') === '1',
  view: OV[q.get('v')] ? q.get('v') : 'nocar',
  show: { pre: true, fac: true, shelter: true, worship: false, roads: true },
  dist: [1, 2, 5].includes(+q.get('d')) ? +q.get('d') : 2,
  rate: [10, 20, 50, 100].includes(+q.get('u')) ? +q.get('u') : 20,
};
if (q.get('s') !== null) for (const [ch, key] of Object.entries(SHOW_KEYS)) S.show[key] = q.get('s').includes(ch);

// Data, loaded once on map load.
let tracts, scen, points, roadsSummary, shelterReach, siteSize, capacity, gaps;
let ready = false;
let keyList = [];
let lastFlood = [];
const tractById = new Map();
const tractBounds = new Map();
const featById = new Map();

// Scenario helpers. Bitmask bits match the pipeline (common.LAYERS): 0-3 Bay +1..+4 ft, 4-7 low-lying +1..+4 ft,
// 8 FEMA 100-yr, 9 FEMA 500-yr, 10-11 Bay and low-lying +2.5 ft.
const BAY_BIT = { 1: 0, 2: 1, 3: 2, 4: 3, 2.5: 10 };
const LOW_BIT = { 1: 4, 2: 5, 3: 6, 4: 7, 2.5: 11 };
const scenarioKey = () => `b${S.bay}_r${S.rain}_c${S.bay > 0 && S.low ? 1 : 0}`;
const distIdx = () => ({ 1: 0, 2: 2, 5: 4 })[S.dist];
const scenarioShares = () => scen.scenarios[scenarioKey()] || {};
const gapEntry = () => gaps?.[scenarioKey()]?.[S.dist] || null;
function neededMask() {
  let m = 0;
  if (S.bay > 0) {
    m |= 1 << BAY_BIT[S.bay];
    if (S.low) m |= 1 << LOW_BIT[S.bay];
  }
  if (S.rain >= 100) m |= 256;
  if (S.rain >= 500) m |= 512;
  return m;
}

// ---- formatting ------------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-US');
function approx(n) {
  if (n < 0.5) return '0';
  if (n < 10) return '<10';
  const step = n < 1000 ? 10 : n < 100000 ? 100 : 1000;
  return '~' + nf.format(Math.round(n / step) * step);
}
const needText = (n) => (n < 5 ? 'fewer than 5' : n < 10 ? `~${Math.round(n)}` : approx(n));
const pct = (x) => (isFinite(x) ? (100 * x).toFixed(1) + '%' : '–');
const money = (v) => '$' + nf.format(Math.round(v / 1000) * 1000);
const short = (name) => name.replace('Census Tract ', 'Tract ');

// ---- data loading ----------------------------------------------------------------------------

const EMPTY = { type: 'FeatureCollection', features: [] };
const cache = new Map();
function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }));
  }
  return cache.get(url);
}

function extendBounds(coords, b = [[180, 90], [-180, -90]]) {
  const walk = (a) => {
    if (typeof a[0] !== 'number') return a.forEach(walk);
    b[0][0] = Math.min(b[0][0], a[0]); b[0][1] = Math.min(b[0][1], a[1]);
    b[1][0] = Math.max(b[1][0], a[0]); b[1][1] = Math.max(b[1][1], a[1]);
  };
  walk(coords);
  return b;
}

// ---- map setup and layers --------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: COUNTY_BOUNDS,
  fitBoundsOptions: { padding: { top: 50, bottom: 12, left: 12, right: 12 } },
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.touchZoomRotate.disableRotation();

function makeIcon(shape, fill, edge, lineWidth) {
  const size = 32, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath();
  if (shape === 'diamond') { g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath(); }
  else if (shape === 'house') { g.moveTo(16, 3); g.lineTo(29, 14); g.lineTo(29, 29); g.lineTo(3, 29); g.lineTo(3, 14); g.closePath(); }
  else g.rect(6, 6, 20, 20);
  g.lineWidth = lineWidth; g.strokeStyle = edge; g.stroke();
  g.fillStyle = fill; g.fill();
  return g.getImageData(0, 0, size, size);
}

// All overlay layers go beneath the basemap's labels, in this stacking order (bottom to top).
function addLayers() {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol').id;
  const add = (layer) => map.addLayer(layer, before);
  for (const id of ['fema500', 'fema100', 'low', 'bay', 'uncov-areas', 'roads', 'points']) map.addSource(id, { type: 'geojson', data: EMPTY });
  map.addSource('tracts', { type: 'geojson', data: tracts, promoteId: 'GEOID' });

  add({ id: 'tracts-fill', type: 'fill', source: 'tracts', paint: { 'fill-color': '#999', 'fill-opacity': 0.8 } });
  add({ id: 'tracts-line', type: 'line', source: 'tracts', paint: { 'line-color': COLORS.edge, 'line-width': 0.5, 'line-opacity': 0.6 } });
  for (const [id, dash, width, alpha] of [['fema500', [3, 2], 1, 0.06], ['fema100', [1, 0], 1.2, 0.12]]) {
    add({ id: `${id}-fill`, type: 'fill', source: id, paint: { 'fill-color': COLORS.fema, 'fill-opacity': alpha } });
    add({ id: `${id}-line`, type: 'line', source: id, paint: { 'line-color': COLORS.fema, 'line-width': width, 'line-opacity': 0.8, 'line-dasharray': dash } });
  }
  add({ id: 'low-fill', type: 'fill', source: 'low', paint: { 'fill-color': COLORS.low, 'fill-opacity': 0.65 } });
  add({ id: 'bay-fill', type: 'fill', source: 'bay', paint: { 'fill-color': COLORS.bay, 'fill-opacity': 0.72 } });
  add({ id: 'uncov-fill', type: 'fill', source: 'uncov-areas', minzoom: ZOOM_DETAIL, paint: { 'fill-color': '#7b1fa2', 'fill-opacity': 0.35 } });
  add({ id: 'uncov-line', type: 'line', source: 'uncov-areas', minzoom: ZOOM_DETAIL, paint: { 'line-color': '#4a148c', 'line-width': 2.5, 'line-dasharray': [2, 1.2] } });

  const roadWidth = (extra) => ['interpolate', ['linear'], ['zoom'],
    9, ['match', ['get', 'h'], 'fwy', 2 + extra, 'art', 1.4 + extra, 1 + extra],
    14, ['match', ['get', 'h'], 'fwy', 6 + extra, 'art', 4.5 + extra, 3.5 + extra]];
  const roadLayout = { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' };
  add({ id: 'roads-casing', type: 'line', source: 'roads', layout: roadLayout, paint: { 'line-color': '#ffffff', 'line-width': roadWidth(2) } });
  add({ id: 'roads-line', type: 'line', source: 'roads', layout: roadLayout, paint: { 'line-color': '#d03b3b', 'line-width': roadWidth(0) } });

  const icon = { pixelRatio: 2 };
  map.addImage('afm-fac-ok', makeIcon('diamond', '#4a3aa7', '#ffffff', 5), icon);
  map.addImage('afm-fac-bad', makeIcon('diamond', '#d03b3b', '#ffffff', 5), icon);
  map.addImage('afm-shelter', makeIcon('square', '#008300', '#ffffff', 5), icon);
  map.addImage('afm-worship', makeIcon('square', '#ffffff', '#008300', 5), icon);
  map.addImage('afm-pre', makeIcon('house', '#006b2e', '#ffffff', 5), icon);
  map.addImage('afm-pre-bad', makeIcon('house', '#d03b3b', '#ffffff', 5), icon);
  const size = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 9, a, 12, b, 15, c];
  const kinds = (list) => ['in', ['get', 'k'], ['literal', list]];
  const is = (prop, v) => ['==', ['get', prop], v];
  const sym = (id, img, filter, sz, opacity = 1) => add({
    id, type: 'symbol', source: 'points', filter,
    layout: { 'icon-image': img, 'icon-size': sz, 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: 'none' },
    paint: { 'icon-opacity': opacity },
  });
  const dry = (sel, key) => ['all', sel, is('f', 0), is('key', key)];
  sym('pts-worship', 'afm-worship', dry(is('k', 'worship'), 0), size(0.4, 0.55, 0.8), 0.3);
  sym('pts-shelter', 'afm-shelter', dry(kinds(SHELTER_KINDS), 0), size(0.45, 0.65, 0.95), 0.3);
  sym('pts-worship-key', 'afm-worship', dry(is('k', 'worship'), 1), size(0.7, 0.95, 1.3));
  sym('pts-shelter-key', 'afm-shelter', dry(kinds(SHELTER_KINDS), 1), size(0.8, 1.05, 1.4));
  add({
    id: 'pts-pre-over', type: 'circle', source: 'points', filter: ['all', is('k', 'pre'), is('f', 0), is('over', 1)], layout: { visibility: 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 9, 15, 19], 'circle-color': 'rgba(208,59,59,0.12)', 'circle-stroke-color': '#d03b3b', 'circle-stroke-width': 2.5 },
  });
  sym('pts-pre', 'afm-pre', ['all', is('k', 'pre'), is('f', 0)], size(0.8, 1.05, 1.4));
  sym('pts-pre-bad', 'afm-pre-bad', ['all', is('k', 'pre'), is('f', 1)], size(0.85, 1.1, 1.45));
  sym('pts-fac', 'afm-fac-ok', ['all', kinds(FAC_KINDS), is('f', 0)], size(0.35, 0.55, 0.95), 0.55);
  sym('pts-fac-bad', 'afm-fac-bad', ['all', kinds(FAC_KINDS), is('f', 1)], size(0.85, 1.15, 1.5));
  add({ id: 'tract-sel', type: 'line', source: 'tracts', filter: is('GEOID', ''), paint: { 'line-color': COLORS.sel, 'line-width': 3 } });

  // Uncovered-area labels sit above everything, including basemap labels.
  map.addSource('uncov-pts', { type: 'geojson', data: EMPTY });
  const labelPaint = { 'text-color': '#4a148c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 };
  const labelLayout = { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5 };
  map.addLayer({
    id: 'uncov-label', type: 'symbol', source: 'uncov-pts', minzoom: ZOOM_DETAIL, filter: is('kind', 'piece'),
    layout: { ...labelLayout, 'text-max-width': 14, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: labelPaint,
  });
  map.addLayer({
    id: 'uncov-city', type: 'symbol', source: 'uncov-pts', maxzoom: ZOOM_DETAIL, filter: is('kind', 'city'),
    layout: { ...labelLayout, 'text-max-width': 16 }, paint: labelPaint,
  });
}

// ---- map updates -----------------------------------------------------------------------------

function applyShow() {
  const groups = {
    fac: ['pts-fac', 'pts-fac-bad'], shelter: ['pts-shelter', 'pts-shelter-key'], worship: ['pts-worship', 'pts-worship-key'],
    pre: ['pts-pre', 'pts-pre-bad', 'pts-pre-over'], roads: ['roads-casing', 'roads-line'],
  };
  for (const [key, ids] of Object.entries(groups)) for (const id of ids) map.setLayoutProperty(id, 'visibility', S.show[key] ? 'visible' : 'none');
}

function breaksFor(o) {
  if (o._breaks) return o._breaks;
  const vals = tracts.features.map((f) => f.properties[o.field]).filter((v) => v != null && !isNaN(v)).sort((a, b) => a - b);
  const quantile = (k) => vals[Math.floor((vals.length * k) / 5)];
  const round = o.unit === '$' ? (v) => Math.round(v / 1000) * 1000 : (v) => Math.round(v * 10) / 10;
  const out = [];
  for (const k of [1, 2, 3, 4]) {
    const v = round(quantile(k));
    if (!out.length || v > out[out.length - 1]) out.push(v);
  }
  return (o._breaks = out);
}

// colors for each class, low to high value
function classColors(o, n) {
  const ramp = COLORS.ramp;
  const pick = Array.from({ length: n }, (_, i) => ramp[n === 1 ? 0 : Math.round((i * (ramp.length - 1)) / (n - 1))]);
  return o.invert ? pick.reverse() : pick;
}

function applyShading() {
  const o = OV[S.view];
  if (!o.field) {
    map.setPaintProperty('tracts-fill', 'fill-opacity', 0.01);  // invisible but still clickable
    return;
  }
  const b = breaksFor(o);
  const cols = classColors(o, b.length + 1);
  const v = ['to-number', ['get', o.field], -1];
  const step = ['step', v, cols[0]];
  b.forEach((br, i) => step.push(br, cols[i + 1]));
  map.setPaintProperty('tracts-fill', 'fill-color', ['case', ['<', v, 0], COLORS.nodata, step]);
  map.setPaintProperty('tracts-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 0.5]);
}

// Async layer updates use a token so a slow, outdated request never overwrites a newer one.
let floodToken = 0;
async function applyFlood() {
  const token = ++floodToken;
  const [bay, low, f100, f500] = await Promise.all([
    S.bay > 0 ? getJSON(`data/flood/bay_${S.bay}ft.geojson`) : EMPTY,
    S.bay > 0 && S.low ? getJSON(`data/flood/low_${S.bay}ft.geojson`) : EMPTY,
    S.rain >= 100 ? getJSON('data/flood/fema_100yr.geojson') : EMPTY,
    S.rain >= 500 ? getJSON('data/flood/fema_500yr.geojson') : EMPTY,
  ]);
  if (token !== floodToken) return;
  lastFlood = [bay, low, f100, f500];
  map.getSource('bay').setData(bay);
  map.getSource('low').setData(low);
  map.getSource('fema100').setData(f100);
  map.getSource('fema500').setData(f500);
}

let roadsToken = 0;
async function applyRoads() {
  const token = ++roadsToken;
  const need = [];
  if (S.bay > 0) { need.push(`bay_${S.bay}ft`); if (S.low) need.push(`low_${S.bay}ft`); }
  if (S.rain >= 100) need.push(S.rain >= 500 ? 'fema_500yr' : 'fema_100yr');
  const parts = await Promise.all(need.map((n) => getJSON(`data/roads/${n}.geojson`).catch(() => EMPTY)));
  if (token !== roadsToken) return;
  map.getSource('roads').setData({ type: 'FeatureCollection', features: parts.flatMap((p) => p.features) });
}

// Marks each site as flooded (f), key shelter (key), or over capacity (over) for the current settings.
function applyPoints() {
  const m = neededMask();
  keyList = computeKeys();
  const keyIds = new Set(keyList.map((k) => k.p.id));
  const overIds = new Set(overCapacity().map((o) => o.id));
  for (const f of points.features) {
    f.properties.f = f.properties.m & m ? 1 : 0;
    f.properties.key = keyIds.has(f.properties.id) ? 1 : 0;
    f.properties.over = overIds.has(f.properties.id) ? 1 : 0;
  }
  map.getSource('points').setData(points);
}

let uncovToken = 0;
async function applyUncovered() {
  const e = gapEntry(), rate = S.rate / 100, on = Boolean(S.show.pre && e);
  const token = ++uncovToken;
  const data = on ? await getJSON(`data/uncovered/${scenarioKey()}.geojson`).catch(() => EMPTY) : EMPTY;
  if (token !== uncovToken) return;
  const shown = data.features.filter((f) => f.properties.km === S.dist && f.properties.people * rate >= 0.5);
  map.getSource('uncov-areas').setData({ type: 'FeatureCollection', features: shown.filter((f) => f.properties.kind === 'area') });
  const pieces = shown.filter((f) => f.properties.kind === 'label').map((f) => ({
    ...f, properties: { kind: 'piece', label: `No pre-identified shelter in range\nest. need ${needText(f.properties.people * rate)} residents` },
  }));
  const cities = on ? Object.entries(e.u).filter(([, u]) => u[0] * rate >= 0.5).map(([city, u]) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: u[2] },
    properties: { kind: 'city', label: `${city}: est. need ${needText(u[0] * rate)} residents with no pre-identified shelter in range (zoom in to see where)` },
  })) : [];
  map.getSource('uncov-pts').setData({ type: 'FeatureCollection', features: [...pieces, ...cities] });
}

// ---- analysis --------------------------------------------------------------------------------

// Totals of people, homes, and each indicator in flooded areas versus the county.
function compute() {
  const sc = scenarioShares();
  const r = { people: 0, homes: 0, cPeople: 0, cHomes: 0, ind: {}, rows: [] };
  for (const o of TABLE_ROWS) r.ind[o.id] = { hit: 0, hitUni: 0, all: 0, allUni: 0 };
  for (const f of tracts.features) {
    const p = f.properties;
    const [ps, hs] = sc[p.GEOID] || [0, 0];
    r.cPeople += p.pop20; r.cHomes += p.hu20;
    r.people += ps * p.pop20; r.homes += hs * p.hu20;
    const row = { id: p.GEOID, share: ps, metric: ps * p.pop20 };
    for (const o of TABLE_ROWS) {
      if (p[o.count] == null || p[o.uni] == null) continue;
      const sh = o.weight === 'pop' ? ps : hs;
      const a = r.ind[o.id];
      a.hit += sh * p[o.count]; a.hitUni += sh * p[o.uni];
      a.all += p[o.count]; a.allUni += p[o.uni];
      if (o.id === S.view) row.metric = sh * p[o.count];
    }
    if (ps > 0.0005) r.rows.push(row);
  }
  return r;
}

// Dry potential shelters with the most affected residents nearby, up to KEY_PER_CITY per city.
function computeKeys() {
  const reach = shelterReach?.[scenarioKey()];
  if (!reach) return [];
  const m = neededMask();
  const kinds = [...(S.show.shelter ? SHELTER_KINDS : []), ...(S.show.worship ? ['worship'] : [])];
  const i = distIdx();
  const cand = [];
  for (const f of points.features) {
    const p = f.properties, e = reach[p.id];
    if (!e || !kinds.includes(p.k) || p.m & m) continue;
    const score = e[i] + e[i + 1];
    if (score >= KEY_MIN) cand.push({ p, coords: f.geometry.coordinates, people: e[i], nocar: e[i + 1], score });
  }
  cand.sort((a, b) => b.score - a.score);
  const perCity = {};
  return cand.filter((c) => (perCity[c.p.c] = (perCity[c.p.c] || 0) + 1) <= KEY_PER_CITY);
}

// Pre-identified shelters whose assigned residents, at the chosen shelter-use share, exceed their capacity.
function overCapacity() {
  const e = gapEntry(), out = [];
  if (!e) return out;
  for (const [id, assigned] of Object.entries(e.a)) {
    const cap = capacity?.sites?.[id]?.[0];
    const need = assigned * S.rate / 100;
    if (cap && need > cap) out.push({ id: +id, need, cap, short: need - cap, cands: e.c[id] || [] });
  }
  return out.sort((a, b) => b.short - a.short);
}

function capacityOf(p) {
  const s = capacity?.sites?.[p.id];
  if (s) return { n: s[0], evac: s[1], role: s[2], surveyed: true };
  const t = p.b && capacity?.types?.[p.b];
  return t ? { n: t.overnight, low: t.low, high: t.high, evac: t.evacuation, surveyed: false } : null;
}
const capText = (c) => (!c ? '' : c.surveyed ? ` · room for ${nf.format(c.n)} overnight` : ` · room for ~${nf.format(c.n)} overnight (est.)`);
function sizeNote(p) {
  const s = siteSize?.[p.id];
  return s && REL[s[1]] ? REL[s[1]] : '';
}
const siteLine = (p) => [p.c, p.k === 'pre' ? null : KIND[p.k], BUCKET[p.b], sizeNote(p)].filter(Boolean).join(' · ');

// ---- panel -----------------------------------------------------------------------------------

function siteButton(k, right, rightTitle) {
  return el('li', {}, el('button', { type: 'button', onclick: () => focusSite(k) },
    el('span', {}, el('div', { class: 'place', text: k.p.n }), el('div', { class: 'sub2', text: siteLine(k.p) + capText(capacityOf(k.p)) })),
    el('span', { class: 'n', title: rightTitle, text: right })));
}

function renderSummary(r) {
  const box = $('#summary');
  box.replaceChildren(el('h2', { text: 'In flooded areas (estimates)' }));
  if (r.people < 0.5) {
    box.append(el('p', { class: 'empty', text: 'No residents are in flooded areas in this scenario. Raise the Bay water level or turn on FEMA zones.' }));
    return;
  }
  box.append(el('div', { class: 'tiles' },
    el('div', { class: 'tile' }, el('div', { class: 'big', text: approx(r.people) }), el('div', { class: 'lbl', text: `people (${pct(r.people / r.cPeople)} of county)` })),
    el('div', { class: 'tile' }, el('div', { class: 'big', text: approx(r.homes) }), el('div', { class: 'lbl', text: `homes (${pct(r.homes / r.cHomes)} of county)` })),
  ));
  const rows = TABLE_ROWS.map((o) => {
    const a = r.ind[o.id];
    const here = a.hit / a.hitUni, all = a.all / a.allUni;
    const ratio = here / all;
    const flag = ratio >= 1.15 ? ' ▲' : ratio <= 0.85 ? ' ▼' : '';
    const tip = ratio >= 1.15 ? 'Higher than countywide' : ratio <= 0.85 ? 'Lower than countywide' : 'Similar to countywide';
    return el('tr', {},
      el('td', { text: o.label }),
      el('td', { class: 'num', text: approx(a.hit) }),
      el('td', { class: 'num', title: tip, text: pct(here) + flag }),
      el('td', { class: 'num', text: pct(all) }),
    );
  });
  box.append(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Group' }), el('th', { class: 'num', text: 'Count' }), el('th', { class: 'num', text: 'Share here' }), el('th', { class: 'num', text: 'Countywide' }))),
    el('tbody', {}, rows),
  ));
  box.append(el('p', { class: 'note', text: '▲ more common in flooded areas than countywide, ▼ less common. Households are used for car access, language, and renting; residents for the rest.' }));
}

function renderResponse(r) {
  const box = $('#response');
  box.replaceChildren(el('h2', { text: 'Emergency response (estimates)' }));
  const m = neededMask();
  const by = {};
  let dryPreCap = 0;
  for (const f of points.features) {
    const p = f.properties;
    const a = (by[p.k] ||= { n: 0, hit: 0, hitCap: 0, names: [] });
    a.n++;
    if (p.m & m) {
      a.hit++;
      a.hitCap += p.cap || 0;
      if (FAC_KINDS.includes(p.k)) a.names.push(`${p.n} (${KIND[p.k].toLowerCase()})`);
      else if (p.k === 'pre') a.names.push(p.n);
    } else if (p.k === 'pre') dryPreCap += capacity?.sites?.[p.id]?.[0] || 0;
  }
  const row = (label, value) => el('tr', {}, el('td', { text: label }), el('td', { class: 'num', text: value }));

  box.append(el('h3', { class: 'sub-h', text: 'Critical facilities in flooded areas' }),
    el('table', {}, el('tbody', {}, FAC_KINDS.filter((k) => by[k]).map((k) => row(KIND_PLURAL[k],
      `${by[k].hit} of ${by[k].n}${by[k].hitCap && CAP_UNIT[k] ? ` (${nf.format(by[k].hitCap)} ${CAP_UNIT[k]})` : ''}`)))));
  const names = FAC_KINDS.flatMap((k) => by[k]?.names || []);
  if (names.length) box.append(el('p', { class: 'note', text: `Flooded: ${names.slice(0, 8).join('; ')}${names.length > 8 ? `; and ${names.length - 8} more` : ''}.` }));
  box.append(el('p', { class: 'note', text: 'Hospitals, care facilities, and dialysis clinics come from state licensing lists, with licensed beds or stations in parentheses. Fire and police stations come from OpenStreetMap.' }));

  if (by.pre) renderPreIdentified(box, by.pre, dryPreCap, r, m);
  renderGaps(box, r);

  box.append(el('h3', { class: 'sub-h', text: 'Potential shelters that stay dry' }),
    el('table', {}, el('tbody', {},
      SHELTER_KINDS.filter((k) => by[k]).map((k) => row(KIND_PLURAL[k], `${by[k].n - by[k].hit} of ${by[k].n}`)),
      by.worship ? row('Places of worship (lower confidence)', `${by.worship.n - by.worship.hit} of ${by.worship.n}`) : null)));
  box.append(el('p', { class: 'note', text: 'Potential shelters are not official and not confirmed open. They are public schools, community centers, libraries, and places of worship that are not in the flooded area in this scenario.' }));

  renderKeyShelters(box);

  const rs = roadsSummary?.[scenarioKey()];
  if (rs) {
    box.append(el('h3', { class: 'sub-h', text: 'Major roads under water' }));
    if (rs.km < 0.05) box.append(el('p', { class: 'empty', text: 'None in this scenario.' }));
    else {
      box.append(el('p', { class: 'note', text: `About ${rs.km.toFixed(rs.km < 10 ? 1 : 0)} km of freeways, highways, and main streets.` }),
        el('table', {}, el('tbody', {}, rs.top.slice(0, 6).map(([n, km]) => row(n, `${km.toFixed(1)} km`)))));
    }
    box.append(el('p', { class: 'note', text: 'Bridges, elevated roadway, and tunnels are not counted.' }));
  }
}

function renderPreIdentified(box, pre, dryCap, r, m) {
  box.append(el('h3', { class: 'sub-h', text: 'Pre-identified shelters' }),
    el('p', { class: 'note', text: `${pre.n - pre.hit} of ${pre.n} are outside the flooded area in this scenario.` }));
  if (dryCap) box.append(el('p', { class: 'note', text: `Together they can shelter about ${nf.format(dryCap)} people overnight, compared with ${approx(r.people)} people living in flooded areas.` }));
  if (pre.names.length) box.append(el('p', { class: 'warn-note', text: `In a flooded area: ${pre.names.join('; ')}.` }));
  const reach = shelterReach?.[scenarioKey()] || {};
  const i = distIdx();
  const ranked = points.features
    .filter((f) => f.properties.k === 'pre' && !(f.properties.m & m) && reach[f.properties.id]?.[i] > 0)
    .map((f) => ({ p: f.properties, coords: f.geometry.coordinates, people: reach[f.properties.id][i] }))
    .sort((a, b) => b.people - a.people).slice(0, 8);
  if (!ranked.length) return;
  box.append(el('p', { class: 'note', text: `Closest to affected residents (within ${S.dist} km):` }),
    el('ol', { class: 'toplist' }, ranked.map((k) => siteButton(k, approx(k.people), 'Affected residents nearby'))));
}

function renderKeyShelters(box) {
  box.append(el('h3', { class: 'sub-h', text: `Key shelters: near affected residents (within ${S.dist} km)` }));
  if (!S.show.shelter && !S.show.worship) box.append(el('p', { class: 'empty', text: 'Turn on potential shelters above to see key shelters.' }));
  else if (!keyList.length) box.append(el('p', { class: 'empty', text: `No dry sites have ${KEY_MIN} or more affected residents within ${S.dist} km in this scenario.` }));
  else {
    const cities = new Set(keyList.map((k) => k.p.c)).size;
    box.append(el('p', { class: 'note', text: `${keyList.length} site${keyList.length === 1 ? '' : 's'} in ${cities} cit${cities === 1 ? 'y' : 'ies'}, up to ${KEY_PER_CITY} per city, ranked by affected residents nearby (residents without a car count twice). Other sites are faded on the map.` }),
      el('ol', { class: 'toplist' }, keyList.slice(0, LIST_N).map((k) => siteButton(k, approx(k.people), `${nf.format(k.nocar)} without a car (estimated)`))));
    const caps = keyList.map((k) => capacityOf(k.p));
    const est = caps.reduce((t, c) => t + (c ? c.n : 0), 0), none = caps.filter((c) => !c).length;
    if (est) box.append(el('p', { class: 'note', text: `Estimated overnight capacity of all ${keyList.length} key sites: about ${nf.format(Math.round(est / 100) * 100)}${none ? ` (${none} site${none === 1 ? '' : 's'} of types without an estimate not counted)` : ''}.` }));
    if (keyList.length > LIST_N) box.append(el('p', { class: 'note', text: `Showing the top ${LIST_N}. All ${keyList.length} are highlighted on the map.` }));
  }
  box.append(el('p', { class: 'note', text: 'Estimated capacity (est.) is the typical overnight capacity of pre-identified shelters of the same type and can be off by a third or more; there is no estimate for elementary schools, libraries, or small schools. Size compares each site\'s main building with others of the same type. Distances are straight-line and ignore water and flooded roads. Sites are not confirmed as shelters.' }));
}

function candidateList(cands, rate) {
  const ul = el('ul', { class: 'cands' });
  for (const [id, reach] of cands.slice(0, 3)) {
    const f = featById.get(id);
    if (!f) continue;
    const p = f.properties, cap = capacityOf(p);
    ul.append(el('li', {}, el('button', { type: 'button', class: 'link', onclick: () => focusSite({ p, coords: f.geometry.coordinates }), text: p.n }),
      document.createTextNode(` · ${BUCKET[p.b] || KIND[p.k]}${cap ? ` · ~${nf.format(cap.n)} overnight (est.)` : ''} · within reach of ${approx(reach * rate)} of them`)));
  }
  return ul;
}

function renderGaps(box, r) {
  const e = gapEntry();
  box.append(el('h3', { class: 'sub-h', text: 'Shelter capacity gaps' }));
  if (!e || r.people < 0.5) { box.append(el('p', { class: 'empty', text: 'No residents are in flooded areas in this scenario.' })); return; }
  const rate = S.rate / 100;
  box.append(el('p', { class: 'note', text: `If ${S.rate}% of the ${approx(r.people)} people in flooded areas need a public shelter (${approx(r.people * rate)} people), each going to the nearest dry pre-identified shelter within ${S.dist} km:` }));
  const over = overCapacity();
  const uncovered = Object.entries(e.u).map(([city, [n, cands]]) => ({ city, need: n * rate, cands })).filter((u) => u.need >= 5).sort((a, b) => b.need - a.need);
  if (!over.length && !uncovered.length) {
    box.append(el('p', { class: 'empty', text: `No pre-identified shelter is over capacity, and every affected area has one within ${S.dist} km.` }));
    return;
  }
  const contacts = (cands) => (cands.length ? [el('div', { class: 'sub2', text: 'Nearby sites to contact:' }), candidateList(cands, rate)] : []);
  if (over.length) {
    box.append(el('p', { class: 'gap-h', text: `Over capacity (${over.length})` }));
    for (const o of over) {
      const f = featById.get(o.id);
      box.append(el('div', { class: 'gap' },
        el('div', {}, el('button', { type: 'button', class: 'link strong', onclick: () => focusSite({ p: f.properties, coords: f.geometry.coordinates }), text: f.properties.n }),
          document.createTextNode(` · ${f.properties.c}`)),
        el('div', { class: 'sub2', text: `${approx(o.need)} would come here, room for ${nf.format(o.cap)}: short ${approx(o.short)}` }),
        ...contacts(o.cands)));
    }
  }
  if (uncovered.length) {
    box.append(el('p', { class: 'gap-h', text: `No pre-identified shelter within ${S.dist} km (${uncovered.length} cit${uncovered.length === 1 ? 'y' : 'ies'})` }));
    for (const u of uncovered) {
      box.append(el('div', { class: 'gap' },
        el('div', { class: 'strong', text: u.city }),
        el('div', { class: 'sub2', text: `${approx(u.need)} people would need a shelter farther away` }),
        ...contacts(u.cands)));
    }
  }
  box.append(el('p', { class: 'note', text: 'Suggested sites are dry potential shelters within range of the residents who would need them, larger site types first. They have not been contacted or confirmed. The share needing a shelter is a planning assumption.' }));
}

function renderTop(r) {
  const box = $('#top');
  const o = OV[S.view];
  const list = r.rows.filter((x) => x.metric >= 0.5).sort((a, b) => b.metric - a.metric).slice(0, 6);
  box.replaceChildren();
  if (!list.length) return;
  box.append(el('h2', { text: `Most affected neighborhoods: ${o.noun || 'people'}` }));
  box.append(el('ol', { class: 'toplist' }, list.map((x) => {
    const p = tractById.get(x.id);
    return el('li', {}, el('button', { type: 'button', onclick: () => focusTract(x.id) },
      el('span', {}, el('div', { class: 'place', text: `${p.place} – ${short(p.name)}` }), el('div', { class: 'sub2', text: `${Math.round(x.share * 100)}% of residents in flooded area` })),
      el('span', { class: 'n', text: approx(x.metric) })));
  })));
}

function renderLegend() {
  const sw = (cls, style) => el('span', { class: `sw ${cls}`, style });
  const item = (swatch, text) => el('div', { class: 'row' }, swatch, el('span', { text }));
  const rows = [
    el('h3', { text: 'Flooding' }),
    item(sw('', `background:${COLORS.bay}`), 'Bay water reaches here'),
    item(sw('', `background:${COLORS.low}`), 'Low-lying, may not drain'),
    item(sw('line', `border-top-color:${COLORS.fema}`), 'FEMA 100-year zone'),
    item(sw('line dash', `border-top-color:${COLORS.fema}`), 'FEMA 500-year zone'),
  ];
  const sites = [];
  if (S.show.fac) sites.push(item(sw('dia', 'background:#4a3aa7'), 'Critical facility'), item(sw('dia', 'background:#d03b3b'), 'Critical facility, flooded'));
  if (S.show.pre) {
    sites.push(item(sw('house', 'background:#006b2e'), 'Pre-identified shelter'), item(sw('house', 'background:#d03b3b'), 'Pre-identified shelter, flooded'),
      item(sw('ring', ''), 'Pre-identified shelter, over capacity'), item(sw('uncov', ''), 'No pre-identified shelter in range'));
  }
  if (S.show.shelter) sites.push(item(sw('sq', 'background:#008300'), 'Key shelter (dry)'), item(sw('sq', 'background:#008300;opacity:0.3'), 'Other potential shelter'));
  if (S.show.worship) sites.push(item(sw('sq', 'background:#fff;border-color:#008300'), 'Place of worship (dry; faded if not key)'));
  if (S.show.roads) sites.push(item(sw('road', ''), 'Flooded major road'));
  if (sites.length) rows.push(el('hr'), ...sites);
  const o = OV[S.view];
  if (o.field) {
    const b = breaksFor(o);
    const cols = classColors(o, b.length + 1);
    const f = (v) => (o.unit === '$' ? '$' + nf.format(v / 1000) + 'k' : v + '%');
    rows.push(el('hr'), el('h3', { text: o.invert ? `${o.title} (darker = lower)` : o.title }),
      el('div', { class: 'ramp' }, cols.map((c, i) => el('div', { style: `background:${c}`, title: i === 0 ? `Under ${f(b[0])}` : i === b.length ? `${f(b[i - 1])} and over` : `${f(b[i - 1])} to ${f(b[i])}` }))),
      el('div', { class: 'ramp-labels' }, el('span', { text: `< ${f(b[0])}` }), el('span', { text: `${f(b[b.length - 1])}+` })),
      item(sw('', `background:${COLORS.nodata}`), 'No data'));
  }
  $('#legendBody').replaceChildren(...rows);
}

function renderControls() {
  const press = (group, match) => { for (const b of $(group).children) b.setAttribute('aria-pressed', String(match(b.dataset.v))); };
  $('#bay').value = BAY_LEVELS.indexOf(S.bay);
  $('#bayVal').textContent = S.bay === 0 ? 'Normal' : `+${S.bay} ft`;
  $('#bayHint').textContent = BAY_HINTS[S.bay];
  const lowBox = $('#low');
  lowBox.checked = S.low && S.bay > 0;
  lowBox.disabled = S.bay === 0;
  lowBox.closest('.check').classList.toggle('disabled', S.bay === 0);
  press('#rain', (v) => +v === S.rain);
  press('#view', (v) => v === S.view);
  press('#dist', (v) => +v === S.dist);
  press('#rate', (v) => +v === S.rate);
  for (const box of document.querySelectorAll('[data-show]')) box.checked = S.show[box.dataset.show];
}

function syncUrl() {
  const shown = Object.entries(SHOW_KEYS).filter(([, key]) => S.show[key]).map(([ch]) => ch).join('');
  history.replaceState(null, '', `?${new URLSearchParams({ b: S.bay, r: S.rain, c: S.low ? 1 : 0, v: S.view, s: shown, d: S.dist, u: S.rate })}`);
}

// flood: the flood scenario changed (reload flood and road layers). pts: site flags depend on the change.
function update({ flood = true, pts = true } = {}) {
  renderControls();
  syncUrl();
  if (!ready) return;
  const r = compute();
  if (pts) { applyPoints(); applyUncovered(); }
  renderSummary(r);
  renderResponse(r);
  renderTop(r);
  renderLegend();
  if (flood) { applyFlood(); applyRoads(); }
  document.body.dataset.stats = JSON.stringify({ bay: S.bay, rain: S.rain, low: S.low, people: Math.round(r.people), homes: Math.round(r.homes) });
}

// ---- map interaction -------------------------------------------------------------------------

function openPopup(lngLat, body) {
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(el('div', {}, body)).addTo(map);
}

function goToRegion(r) {
  let bounds = r.bounds;
  if (r.flood) {
    const b = [[180, 90], [-180, -90]];
    for (const fc of lastFlood) for (const f of fc.features) extendBounds(f.geometry.coordinates, b);
    bounds = b[0][0] <= b[1][0] ? b : COUNTY_BOUNDS;
  }
  map.fitBounds(bounds, { padding: { top: 56, bottom: 24, left: 24, right: 24 }, maxZoom: 14 });
}

function selectTract(id) {
  map.setFilter('tract-sel', ['==', ['get', 'GEOID'], id || '']);
}

function showTractPopup(id, lngLat) {
  const p = tractById.get(id);
  const sc = scenarioShares()[id] || [0, 0];
  const body = [
    el('h4', { text: `${p.place} · ${short(p.name)}` }),
    el('p', { text: `${nf.format(p.pop20)} residents (2020 Census)` }),
    el('p', { text: sc[0] > 0.0005 ? `About ${Math.round(sc[0] * 100)}% of residents live in flooded areas in this scenario.` : 'No flooded area in this scenario.' }),
  ];
  const o = OV[S.view];
  if (o.field) {
    const v = p[o.field];
    body.push(el('p', { text: `${o.title}: ${v == null ? 'no data' : o.unit === '$' ? money(v) : `${v}%`}` }));
    if (o.count && p[o.count + '_lowrel']) body.push(el('p', { class: 'warn', text: 'Small sample: this estimate has a wide margin of error.' }));
  }
  openPopup(lngLat, body);
}

function showSitePopup(p, coords) {
  const flooded = p.m & neededMask();
  const body = [el('h4', { text: p.n }), el('p', { text: `${KIND[p.k]}${p.c ? ` · ${p.c}` : ''}` })];
  if (p.st) body.push(el('p', { text: `${ST[p.st]}${p.cap ? ` · ${nf.format(p.cap)} licensed ${CAP_UNIT[p.k]}` : ''}` }));
  if (p.k === 'pre') body.push(el('p', { text: 'Identified in advance as a possible emergency shelter. Whether it opens depends on the emergency.' }));
  else if (SHELTER_KINDS.includes(p.k) || p.k === 'worship') body.push(el('p', { text: 'Potential shelter site. Not official and not confirmed open.' }));
  if (p.b) {
    const s = siteSize?.[p.id];
    const size = s && REL[s[1]] ? ` Main building about ${nf.format(s[0])} sq ft, ${REL[s[1]]} for this type (from map building outlines).` : '';
    body.push(el('p', { text: `Type: ${BUCKET[p.b]}.${size}` }));
    const cap = capacityOf(p);
    const assigned = p.k === 'pre' && !flooded ? gapEntry()?.a?.[p.id] : null;
    if (assigned && cap) body.push(el('p', { class: assigned * S.rate / 100 > cap.n ? 'warn' : '', text: `About ${approx(assigned * S.rate / 100).replace('~', '')} people would come here (at ${S.rate}% shelter use, ${S.dist} km).` }));
    if (cap?.surveyed) body.push(el('p', { text: `Capacity: ${nf.format(cap.n)} overnight, ${nf.format(cap.evac)} for a short-term evacuation.${cap.role ? ` ${cap.role[0].toUpperCase() + cap.role.slice(1)} site.` : ''}` }));
    else if (cap) body.push(el('p', { text: `Estimated capacity: about ${nf.format(cap.n)} overnight (typical for this type: ${nf.format(cap.low)}–${nf.format(cap.high)}), based on pre-identified shelters of the same type.` }));
    else body.push(el('p', { text: 'No capacity estimate for this type of site yet.' }));
  }
  body.push(el('p', { class: flooded ? 'warn' : '', text: flooded ? 'In a flooded area in this scenario.' : 'Not in a flooded area in this scenario.' }));
  const e = !flooded && shelterReach?.[scenarioKey()]?.[p.id];
  if (e) {
    const i = distIdx();
    body.push(el('p', { text: `${approx(e[i])} affected residents within ${S.dist} km (${approx(e[i + 1])} without a car).` }));
  }
  openPopup(coords, body);
}

function focusSite(k) {
  map.flyTo({ center: k.coords, zoom: Math.max(map.getZoom(), 13.5) });
  map.once('moveend', () => showSitePopup(k.p, k.coords));
}

function focusTract(id) {
  selectTract(id);
  const bb = tractBounds.get(id);
  map.fitBounds(bb, { padding: 60, maxZoom: 14 });
  map.once('moveend', () => showTractPopup(id, [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2]));
}

// ---- startup ---------------------------------------------------------------------------------

function buildControls() {
  const view = $('#view');
  for (const o of OVERLAYS) view.append(el('button', { type: 'button', class: 'chip', 'data-v': o.id, text: o.label }));
  for (const r of REGIONS) $('#regions').append(el('button', { type: 'button', class: 'region', text: r.label, onclick: () => goToRegion(r) }));
  const onPick = (group, fn) => $(group).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });
  $('#bay').addEventListener('input', (e) => { S.bay = BAY_LEVELS[+e.target.value]; update(); });
  $('#low').addEventListener('change', (e) => { S.low = e.target.checked; update(); });
  onPick('#rain', (v) => { S.rain = +v; update(); });
  onPick('#rate', (v) => { S.rate = +v; update({ flood: false }); });
  onPick('#dist', (v) => { S.dist = +v; update({ flood: false }); });
  onPick('#view', (v) => { S.view = v; if (ready) applyShading(); update({ flood: false, pts: false }); });
  for (const box of document.querySelectorAll('[data-show]')) {
    box.addEventListener('change', () => {
      S.show[box.dataset.show] = box.checked;
      if (ready) { applyShow(); if (box.dataset.show === 'roads' && box.checked) applyRoads(); }
      update({ flood: false });
    });
  }
  $('#legend').open = matchMedia('(min-width: 821px)').matches;
}

buildControls();
renderControls();

map.on('load', async () => {
  const optional = (url, fallback) => getJSON(url).catch(() => fallback);
  [tracts, scen, points, roadsSummary, shelterReach, siteSize, capacity, gaps] = await Promise.all([
    getJSON('data/tracts.geojson'), getJSON('data/scenarios.json'), getJSON('data/points.json'),
    optional('data/roads_summary.json', null), optional('data/shelter_reach.json', null), optional('data/site_size.json', {}),
    optional('data/capacity.json', null), optional('data/capacity_gaps.json', null),
  ]);
  for (const f of points.features) featById.set(f.properties.id, f);
  for (const f of tracts.features) {
    tractById.set(f.properties.GEOID, f.properties);
    tractBounds.set(f.properties.GEOID, extendBounds(f.geometry.coordinates));
  }
  addLayers();
  ready = true;
  applyShading();
  applyShow();
  update();

  map.on('click', 'tracts-fill', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
    const id = e.features[0]?.properties.GEOID;
    if (!id) return;
    selectTract(id);
    showTractPopup(id, e.lngLat);
  });
  map.on('click', POINT_LAYERS, (e) => showSitePopup(e.features[0].properties, e.features[0].geometry.coordinates));
  for (const id of [...POINT_LAYERS, 'tracts-fill']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  document.body.dataset.ready = '1';  // lets automated checks know the page has finished loading
});
