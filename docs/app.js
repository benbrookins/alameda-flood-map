'use strict';

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

const BAY_HINTS = [
  'Normal high tide. No Bay flooding in this scenario.',
  '+1 ft above normal high tide: about a typical king tide.',
  '+2 ft: a king tide with extra high water or a moderate storm surge.',
  '+3 ft: a large storm surge on top of a high tide.',
  '+4 ft: a severe stress test beyond recent experience.',
];

// Orange sequential ramp (steps 100, 250, 350, 450, 700). The map is always light, so low = light.
const RAMP = ['#fbe2d9', '#fcae92', '#f48a63', '#e26331', '#772e10'];
const THEME = { bay: '#2a78d6', low: '#1baf7a', fema: '#3b3a37', edge: '#ffffff', nodata: '#d9d7cf', sel: '#0b0b0b', ramp: RAMP };

// weight: which share applies (pop = people, hu = households). count/uni: tract fields.
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
  hospital: 'Hospital', care: 'Nursing or assisted living', dialysis: 'Dialysis center', fire: 'Fire station', police: 'Police station',
  school: 'School', community: 'Community center', library: 'Library', worship: 'Place of worship',
};
const KIND_PLURAL = {
  hospital: 'Hospitals', care: 'Nursing and assisted living', dialysis: 'Dialysis centers', fire: 'Fire stations', police: 'Police stations',
  school: 'Schools', community: 'Community centers', library: 'Libraries', worship: 'Places of worship',
};
const TIER = { L: 'larger', M: 'medium', S: 'smaller', V: 'size varies' };
const KEY_MIN = 100;     // affected residents nearby, with residents without a car counted twice
const KEY_PER_CITY = 3;  // key shelters kept per city
const LIST_N = 12;
const FAC_KINDS = ['hospital', 'care', 'dialysis', 'fire', 'police'];
const SHELTER_KINDS = ['school', 'community', 'library'];
const SHOW_KEYS = { f: 'fac', s: 'shelter', w: 'worship', r: 'roads' };
const POINT_LAYERS = ['pts-fac', 'pts-fac-bad', 'pts-shelter', 'pts-shelter-key', 'pts-worship', 'pts-worship-key'];

const COUNTY_BOUNDS = [[-122.36, 37.44], [-121.46, 37.92]];
const REGIONS = [
  { label: 'Full county', bounds: COUNTY_BOUNDS },
  { label: 'Berkeley–Oakland–Alameda', bounds: [[-122.34, 37.70], [-122.16, 37.91]] },
  { label: 'San Leandro–Hayward', bounds: [[-122.24, 37.60], [-122.02, 37.74]] },
  { label: 'Fremont–Newark–Union City', bounds: [[-122.15, 37.46], [-121.90, 37.62]] },
  { label: 'Tri-Valley', bounds: [[-122.0, 37.60], [-121.66, 37.76]] },
  { label: 'Fit to flooding', flood: true },
];

// ---- state -----------------------------------------------------------------------------------

const q = new URLSearchParams(location.search);
const S = {
  bay: clampInt(q.get('b'), 0, 4, 0),
  rain: [0, 100, 500].includes(+q.get('r')) ? +q.get('r') : 0,
  low: q.get('c') === '1',
  view: OV[q.get('v')] ? q.get('v') : 'nocar',
  sel: null,
  show: { fac: true, shelter: true, worship: false, roads: true },
  dist: q.get('d') === '1' ? 1 : 2,
};
if (q.get('s') !== null) for (const [ch, key] of Object.entries(SHOW_KEYS)) S.show[key] = q.get('s').includes(ch);
function clampInt(v, lo, hi, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }

let tracts, scen, points, roadsSummary, shelterReach, ready = false;
let keyList = [];
const byId = new Map();
const bboxOf = new Map();
const theme = () => THEME;

// ---- formatting ------------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-US');
function approx(n) {
  if (n < 0.5) return '0';
  if (n < 10) return '<10';
  const step = n < 1000 ? 10 : n < 100000 ? 100 : 1000;
  return '~' + nf.format(Math.round(n / step) * step);
}
const pct = (x) => (isFinite(x) ? (100 * x).toFixed(1) + '%' : '–');
const money = (v) => '$' + nf.format(Math.round(v / 1000) * 1000);
const short = (name) => name.replace('Census Tract ', 'Tract ');

// ---- map -------------------------------------------------------------------------------------

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

const EMPTY = { type: 'FeatureCollection', features: [] };
const cache = new Map();
function getJSON(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }));
  }
  return cache.get(url);
}

function addFloodLayers() {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol').id;
  const t = theme();
  map.addSource('tracts', { type: 'geojson', data: tracts, promoteId: 'GEOID' });
  map.addLayer({ id: 'tracts-fill', type: 'fill', source: 'tracts', paint: { 'fill-color': '#999', 'fill-opacity': 0.8 } }, before);
  map.addLayer({ id: 'tracts-line', type: 'line', source: 'tracts', paint: { 'line-color': t.edge, 'line-width': 0.5, 'line-opacity': 0.6 } }, before);
  for (const id of ['fema500', 'fema100', 'low', 'bay']) map.addSource(id, { type: 'geojson', data: EMPTY });
  const fema = (id, dash, width, alpha) => {
    map.addLayer({ id: `${id}-fill`, type: 'fill', source: id, paint: { 'fill-color': t.fema, 'fill-opacity': alpha } }, before);
    map.addLayer({ id: `${id}-line`, type: 'line', source: id, paint: { 'line-color': t.fema, 'line-width': width, 'line-opacity': 0.8, 'line-dasharray': dash } }, before);
  };
  fema('fema500', [3, 2], 1, 0.06);
  fema('fema100', [1, 0], 1.2, 0.12);
  map.addLayer({ id: 'low-fill', type: 'fill', source: 'low', paint: { 'fill-color': t.low, 'fill-opacity': 0.65 } }, before);
  map.addLayer({ id: 'bay-fill', type: 'fill', source: 'bay', paint: { 'fill-color': t.bay, 'fill-opacity': 0.72 } }, before);
  addSiteLayers(before);
  map.addLayer({ id: 'tract-sel', type: 'line', source: 'tracts', filter: ['==', ['get', 'GEOID'], ''], paint: { 'line-color': t.sel, 'line-width': 3 } }, before);
}

// ---- choropleth ------------------------------------------------------------------------------

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
  const ramp = theme().ramp;
  const pick = Array.from({ length: n }, (_, i) => ramp[n === 1 ? 0 : Math.round((i * (ramp.length - 1)) / (n - 1))]);
  return o.invert ? pick.reverse() : pick;
}

function makeIcon(shape, fill, edge, lineWidth) {
  const size = 32, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath();
  if (shape === 'diamond') { g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath(); } else g.rect(6, 6, 20, 20);
  g.lineWidth = lineWidth; g.strokeStyle = edge; g.stroke();
  g.fillStyle = fill; g.fill();
  return g.getImageData(0, 0, size, size);
}

function addSiteLayers(before) {
  const opt = { pixelRatio: 2 };
  map.addImage('afm-fac-ok', makeIcon('diamond', '#4a3aa7', '#ffffff', 5), opt);
  map.addImage('afm-fac-bad', makeIcon('diamond', '#d03b3b', '#ffffff', 5), opt);
  map.addImage('afm-shelter', makeIcon('square', '#008300', '#ffffff', 5), opt);
  map.addImage('afm-worship', makeIcon('square', '#ffffff', '#008300', 5), opt);

  map.addSource('roads', { type: 'geojson', data: EMPTY });
  const width = (extra) => ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'h'], 'fwy', 2 + extra, 'art', 1.4 + extra, 1 + extra], 14, ['match', ['get', 'h'], 'fwy', 6 + extra, 'art', 4.5 + extra, 3.5 + extra]];
  map.addLayer({ id: 'roads-casing', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': '#ffffff', 'line-width': width(2) } }, before);
  map.addLayer({ id: 'roads-line', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': '#d03b3b', 'line-width': width(0) } }, before);

  map.addSource('points', { type: 'geojson', data: EMPTY });
  const size = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 9, a, 12, b, 15, c];
  const kinds = (list) => ['in', ['get', 'k'], ['literal', list]];
  const sym = (id, icon, filter, sz, opacity = 1) => map.addLayer({
    id, type: 'symbol', source: 'points', filter,
    layout: { 'icon-image': icon, 'icon-size': sz, 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: 'none' },
    paint: { 'icon-opacity': opacity },
  }, before);
  const dry = (list, key) => ['all', list, ['==', ['get', 'f'], 0], ['==', ['get', 'key'], key]];
  const worship = ['==', ['get', 'k'], 'worship'];
  sym('pts-worship', 'afm-worship', dry(worship, 0), size(0.4, 0.55, 0.8), 0.3);
  sym('pts-shelter', 'afm-shelter', dry(kinds(SHELTER_KINDS), 0), size(0.45, 0.65, 0.95), 0.3);
  sym('pts-worship-key', 'afm-worship', dry(worship, 1), size(0.7, 0.95, 1.3));
  sym('pts-shelter-key', 'afm-shelter', dry(kinds(SHELTER_KINDS), 1), size(0.8, 1.05, 1.4));
  sym('pts-fac', 'afm-fac-ok', ['all', kinds(FAC_KINDS), ['==', ['get', 'f'], 0]], size(0.55, 0.8, 1.1));
  sym('pts-fac-bad', 'afm-fac-bad', ['all', kinds(FAC_KINDS), ['==', ['get', 'f'], 1]], size(0.85, 1.15, 1.5));
}

function applyShow() {
  const vis = (on) => (on ? 'visible' : 'none');
  map.setLayoutProperty('pts-fac', 'visibility', vis(S.show.fac));
  map.setLayoutProperty('pts-fac-bad', 'visibility', vis(S.show.fac));
  for (const id of ['pts-shelter', 'pts-shelter-key']) map.setLayoutProperty(id, 'visibility', vis(S.show.shelter));
  for (const id of ['pts-worship', 'pts-worship-key']) map.setLayoutProperty(id, 'visibility', vis(S.show.worship));
  map.setLayoutProperty('roads-casing', 'visibility', vis(S.show.roads));
  map.setLayoutProperty('roads-line', 'visibility', vis(S.show.roads));
}

function neededMask() {
  let m = 0;
  if (S.bay > 0) {
    m |= 1 << (S.bay - 1);
    if (S.low) m |= 1 << (4 + S.bay - 1);
  }
  if (S.rain >= 100) m |= 256;
  if (S.rain >= 500) m |= 512;
  return m;
}

function computeKeys() {
  const reach = shelterReach?.[scenarioKey()];
  if (!reach) return [];
  const m = neededMask();
  const kinds = [...(S.show.shelter ? SHELTER_KINDS : []), ...(S.show.worship ? ['worship'] : [])];
  const i = S.dist === 1 ? 0 : 2;
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

function applyPoints() {
  const m = neededMask();
  keyList = computeKeys();
  const keyIds = new Set(keyList.map((k) => k.p.id));
  for (const f of points.features) {
    f.properties.f = f.properties.m & m ? 1 : 0;
    f.properties.key = keyIds.has(f.properties.id) ? 1 : 0;
  }
  map.getSource('points').setData(points);
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

function applyShading() {
  const o = OV[S.view];
  if (!o.field) {
    map.setPaintProperty('tracts-fill', 'fill-opacity', 0.01);
    return;
  }
  const b = breaksFor(o);
  const cols = classColors(o, b.length + 1);
  const v = ['to-number', ['get', o.field], -1];
  const step = ['step', v, cols[0]];
  b.forEach((br, i) => step.push(br, cols[i + 1]));
  map.setPaintProperty('tracts-fill', 'fill-color', ['case', ['<', v, 0], theme().nodata, step]);
  map.setPaintProperty('tracts-fill', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 0.5]);
}

// ---- flood scenario --------------------------------------------------------------------------

let floodToken = 0;
let lastFlood = [];
async function applyFlood() {
  const token = ++floodToken;
  const lowOn = S.bay > 0 && S.low;
  const [bay, low, f100, f500] = await Promise.all([
    S.bay > 0 ? getJSON(`data/flood/bay_${S.bay}ft.geojson`) : EMPTY,
    lowOn ? getJSON(`data/flood/low_${S.bay}ft.geojson`) : EMPTY,
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

const scenarioKey = () => `b${S.bay}_r${S.rain}_c${S.bay > 0 && S.low ? 1 : 0}`;
function scenarioShares() {
  return scen.scenarios[scenarioKey()] || {};
}

function compute() {
  const sc = scenarioShares();
  const r = { people: 0, homes: 0, cPeople: 0, cHomes: 0, ind: {}, rows: [] };
  for (const o of TABLE_ROWS) r.ind[o.id] = { hit: 0, hitUni: 0, all: 0, allUni: 0 };
  for (const f of tracts.features) {
    const p = f.properties;
    const [ps, hs] = sc[p.GEOID] || [0, 0];
    r.cPeople += p.pop20; r.cHomes += p.hu20;
    r.people += ps * p.pop20; r.homes += hs * p.hu20;
    const row = { id: p.GEOID, people: ps * p.pop20, share: ps, metric: ps * p.pop20 };
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

// ---- rendering -------------------------------------------------------------------------------

function renderSummary(r) {
  const box = $('#summary');
  const flooded = r.people >= 0.5;
  box.replaceChildren(el('h2', { text: 'In flooded areas (estimates)' }));
  if (!flooded) {
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
      el('td', { class: 'num', title: tip }, document.createTextNode(pct(here) + flag)),
      el('td', { class: 'num', text: pct(all) }),
    );
  });
  box.append(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Group' }), el('th', { class: 'num', text: 'Count' }), el('th', { class: 'num', text: 'Share here' }), el('th', { class: 'num', text: 'Countywide' }))),
    el('tbody', {}, rows),
  ));
  box.append(el('p', { class: 'note', text: '▲ more common in flooded areas than countywide, ▼ less common. Households are used for car access, language, and renting; residents for the rest.' }));
}

function renderResponse() {
  const box = $('#response');
  box.replaceChildren(el('h2', { text: 'Emergency response (estimates)' }));
  const m = neededMask();
  const by = {};
  for (const f of points.features) {
    const p = f.properties;
    const a = (by[p.k] ||= { n: 0, hit: 0, names: [] });
    a.n++;
    if (p.m & m) { a.hit++; if (FAC_KINDS.includes(p.k)) a.names.push(`${p.n} (${KIND[p.k].toLowerCase()})`); }
  }
  const rows = (kinds, text) => kinds.filter((k) => by[k]).map((k) => el('tr', {},
    el('td', { text: KIND_PLURAL[k] }), el('td', { class: 'num', text: text(by[k]) })));

  box.append(el('h3', { class: 'sub-h', text: 'Critical facilities in flooded areas' }),
    el('table', {}, el('tbody', {}, rows(FAC_KINDS, (a) => `${a.hit} of ${a.n}`))));
  const names = FAC_KINDS.flatMap((k) => by[k]?.names || []);
  if (names.length) {
    box.append(el('p', { class: 'note', text: `Flooded: ${names.slice(0, 8).join('; ')}${names.length > 8 ? `; and ${names.length - 8} more` : ''}.` }));
  }
  box.append(el('p', { class: 'note', text: 'Facility locations come from OpenStreetMap and are incomplete, especially for nursing and assisted living homes and dialysis centers.' }));

  box.append(el('h3', { class: 'sub-h', text: 'Potential shelters that stay dry' }),
    el('table', {}, el('tbody', {}, rows(SHELTER_KINDS, (a) => `${a.n - a.hit} of ${a.n}`),
      by.worship ? el('tr', {}, el('td', { text: 'Places of worship (lower confidence)' }), el('td', { class: 'num', text: `${by.worship.n - by.worship.hit} of ${by.worship.n}` })) : null)));
  box.append(el('p', { class: 'note', text: 'Potential shelters are not official and not confirmed open. They are public schools, community centers, libraries, and places of worship that are not in the flooded area in this scenario.' }));

  box.append(el('h3', { class: 'sub-h', text: `Key shelters: near affected residents (within ${S.dist} km)` }));
  if (!S.show.shelter && !S.show.worship) box.append(el('p', { class: 'empty', text: 'Turn on potential shelters above to see key shelters.' }));
  else if (!keyList.length) box.append(el('p', { class: 'empty', text: `No dry sites have ${KEY_MIN} or more affected residents within ${S.dist} km in this scenario.` }));
  else {
    const cities = new Set(keyList.map((k) => k.p.c)).size;
    box.append(el('p', { class: 'note', text: `${keyList.length} site${keyList.length === 1 ? '' : 's'} in ${cities} cit${cities === 1 ? 'y' : 'ies'}, up to ${KEY_PER_CITY} per city, ranked by affected residents nearby (residents without a car count twice). Other sites are faded on the map.` }));
    const ol = el('ol', { class: 'toplist' });
    for (const k of keyList.slice(0, LIST_N)) {
      ol.append(el('li', {}, el('button', { type: 'button', onclick: () => focusSite(k) },
        el('span', {}, el('div', { class: 'place', text: k.p.n }), el('div', { class: 'sub2', text: `${k.p.c} · ${KIND[k.p.k]} · ${TIER[k.p.t] || ''}` })),
        el('span', { class: 'n', title: `${nf.format(k.nocar)} without a car (estimated)`, text: approx(k.people) }),
      )));
    }
    box.append(ol);
    if (keyList.length > LIST_N) box.append(el('p', { class: 'note', text: `Showing the top ${LIST_N}. All ${keyList.length} are highlighted on the map.` }));
  }
  box.append(el('p', { class: 'note', text: 'Size is a rough guess from the type of site (high schools larger than elementary schools, schools larger than libraries), not a measured capacity. Distances are straight-line and ignore water and flooded roads. Sites are not confirmed as shelters.' }));

  const rs = roadsSummary?.[scenarioKey()];
  if (rs) {
    box.append(el('h3', { class: 'sub-h', text: 'Major roads under water' }));
    if (rs.km < 0.05) box.append(el('p', { class: 'empty', text: 'None in this scenario.' }));
    else {
      box.append(el('p', { class: 'note', text: `About ${rs.km.toFixed(rs.km < 10 ? 1 : 0)} km of freeways, highways, and main streets.` }),
        el('table', {}, el('tbody', {}, rs.top.slice(0, 6).map(([n, km]) => el('tr', {}, el('td', { text: n }), el('td', { class: 'num', text: `${km.toFixed(1)} km` }))))));
    }
    box.append(el('p', { class: 'note', text: 'Bridges, elevated roadway, and tunnels are not counted.' }));
  }
}

function renderTop(r) {
  const box = $('#top');
  const o = OV[S.view];
  const noun = o.noun || 'people';
  const list = r.rows.filter((x) => x.metric >= 0.5).sort((a, b) => b.metric - a.metric).slice(0, 6);
  box.replaceChildren();
  if (!list.length) return;
  box.append(el('h2', { text: `Most affected neighborhoods: ${noun}` }));
  const ol = el('ol', { class: 'toplist' });
  for (const x of list) {
    const p = byId.get(x.id);
    ol.append(el('li', {}, el('button', { type: 'button', onclick: () => focusTract(x.id) },
      el('span', {}, el('div', { class: 'place', text: p.place }), el('div', { class: 'sub2', text: `${short(p.name)} · ${Math.round(x.share * 100)}% of residents in flooded area` })),
      el('span', { class: 'n', text: approx(x.metric) }),
    )));
  }
  box.append(ol);
}

function renderLegend() {
  const box = $('#legendBody');
  const t = theme();
  const sw = (cls, style) => el('span', { class: `sw ${cls}`, style });
  const rows = [
    el('h3', { text: 'Flooding' }),
    el('div', { class: 'row' }, sw('', `background:${t.bay}`), el('span', { text: 'Bay water reaches here' })),
    el('div', { class: 'row' }, sw('', `background:${t.low}`), el('span', { text: 'Low-lying, may not drain' })),
    el('div', { class: 'row' }, sw('line', `border-top-color:${t.fema}`), el('span', { text: 'FEMA 100-year zone' })),
    el('div', { class: 'row' }, sw('line dash', `border-top-color:${t.fema}`), el('span', { text: 'FEMA 500-year zone' })),
  ];
  const sites = [];
  if (S.show.fac) sites.push(el('div', { class: 'row' }, sw('dia', 'background:#4a3aa7'), el('span', { text: 'Critical facility' })), el('div', { class: 'row' }, sw('dia', 'background:#d03b3b'), el('span', { text: 'Critical facility, flooded' })));
  if (S.show.shelter) sites.push(el('div', { class: 'row' }, sw('sq', 'background:#008300'), el('span', { text: 'Key shelter (dry)' })), el('div', { class: 'row' }, sw('sq', 'background:#008300;opacity:0.3'), el('span', { text: 'Other potential shelter' })));
  if (S.show.worship) sites.push(el('div', { class: 'row' }, sw('sq', 'background:#fff;border-color:#008300'), el('span', { text: 'Place of worship (dry; faded if not key)' })));
  if (S.show.roads) sites.push(el('div', { class: 'row' }, sw('road', ''), el('span', { text: 'Flooded major road' })));
  if (sites.length) rows.push(el('hr'), ...sites);
  const o = OV[S.view];
  if (o.field) {
    const b = breaksFor(o);
    const cols = classColors(o, b.length + 1);
    const f = (v) => (o.unit === '$' ? '$' + nf.format(v / 1000) + 'k' : v + '%');
    rows.push(el('hr'), el('h3', { text: o.invert ? `${o.title} (darker = lower)` : o.title }));
    rows.push(el('div', { class: 'ramp' }, cols.map((c, i) => el('div', { style: `background:${c}`, title: i === 0 ? `Under ${f(b[0])}` : i === b.length ? `${f(b[i - 1])} and over` : `${f(b[i - 1])} to ${f(b[i])}` }))));
    rows.push(el('div', { class: 'ramp-labels' }, el('span', { text: `< ${f(b[0])}` }), el('span', { text: `${f(b[b.length - 1])}+` })));
    rows.push(el('div', { class: 'row' }, sw('', `background:${t.nodata}`), el('span', { text: 'No data' })));
  }
  box.replaceChildren(...rows);
}

function renderControls() {
  $('#bay').value = S.bay;
  $('#bayVal').textContent = S.bay === 0 ? 'Normal' : `+${S.bay} ft`;
  $('#bayHint').textContent = BAY_HINTS[S.bay];
  const lowBox = $('#low');
  lowBox.checked = S.low && S.bay > 0;
  lowBox.disabled = S.bay === 0;
  lowBox.closest('.check').classList.toggle('disabled', S.bay === 0);
  for (const b of $('#rain').children) b.setAttribute('aria-pressed', String(+b.dataset.v === S.rain));
  for (const b of $('#view').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.view));
  for (const box of document.querySelectorAll('[data-show]')) box.checked = S.show[box.dataset.show];
  for (const b of $('#dist').children) b.setAttribute('aria-pressed', String(+b.dataset.v === S.dist));
}

function syncUrl() {
  const shown = Object.entries(SHOW_KEYS).filter(([, key]) => S.show[key]).map(([ch]) => ch).join('');
  const p = new URLSearchParams({ b: S.bay, r: S.rain, c: S.low ? 1 : 0, v: S.view, s: shown, d: S.dist });
  history.replaceState(null, '', `?${p}`);
}

function update({ flood = true, pts = true } = {}) {
  renderControls();
  syncUrl();
  if (!ready) return;
  const r = compute();
  if (pts) applyPoints();
  renderSummary(r);
  renderResponse();
  renderTop(r);
  renderLegend();
  if (flood) { applyFlood(); applyRoads(); }
  window.__stats = { bay: S.bay, rain: S.rain, low: S.low, people: Math.round(r.people), homes: Math.round(r.homes) };
  document.body.dataset.stats = JSON.stringify(window.__stats);
}

// ---- tract interaction -----------------------------------------------------------------------

function bboxFromGeometry(g) {
  let [x0, y0, x1, y1] = [180, 90, -180, -90];
  const walk = (a) => (typeof a[0] === 'number' ? ((x0 = Math.min(x0, a[0])), (x1 = Math.max(x1, a[0])), (y0 = Math.min(y0, a[1])), (y1 = Math.max(y1, a[1]))) : a.forEach(walk));
  walk(g.coordinates);
  return [[x0, y0], [x1, y1]];
}

function floodBounds() {
  let [x0, y0, x1, y1] = [180, 90, -180, -90];
  const walk = (a) => (typeof a[0] === 'number' ? ((x0 = Math.min(x0, a[0])), (x1 = Math.max(x1, a[0])), (y0 = Math.min(y0, a[1])), (y1 = Math.max(y1, a[1]))) : a.forEach(walk));
  for (const fc of lastFlood) for (const f of fc.features) walk(f.geometry.coordinates);
  return x0 > x1 ? null : [[x0, y0], [x1, y1]];
}

function goToRegion(r) {
  const bounds = r.flood ? floodBounds() : r.bounds;
  map.fitBounds(bounds || COUNTY_BOUNDS, { padding: { top: 56, bottom: 24, left: 24, right: 24 }, maxZoom: 14 });
}

function selectTract(id) {
  S.sel = id;
  map.setFilter('tract-sel', ['==', ['get', 'GEOID'], id || '']);
}

function showPopup(id, lngLat) {
  const p = byId.get(id);
  const sc = scenarioShares()[id] || [0, 0];
  const body = [
    el('h4', { text: `${p.place} · ${short(p.name)}` }),
    el('p', { text: `${nf.format(p.pop20)} residents (2020 Census)` }),
    el('p', { text: sc[0] > 0.0005 ? `About ${Math.round(sc[0] * 100)}% of residents live in flooded areas in this scenario.` : 'No flooded area in this scenario.' }),
  ];
  const o = OV[S.view];
  if (o.field) {
    const v = p[o.field];
    const val = v == null ? 'no data' : o.unit === '$' ? money(v) : `${v}%`;
    body.push(el('p', { text: `${o.title}: ${val}` }));
    if (o.count && p[o.count + '_lowrel']) body.push(el('p', { class: 'warn', text: 'Small sample: this estimate has a wide margin of error.' }));
  }
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(el('div', {}, body)).addTo(map);
}

function showSitePopup(p, coords) {
  const flooded = p.m & neededMask();
  const body = [el('h4', { text: p.n }), el('p', { text: `${KIND[p.k]}${p.c ? ` · ${p.c}` : ''}` })];
  if (SHELTER_KINDS.includes(p.k) || p.k === 'worship') {
    body.push(el('p', { text: 'Potential shelter site. Not official and not confirmed open.' }));
    if (p.t) body.push(el('p', { text: `Rough size: ${TIER[p.t]} (guessed from the type of site).` }));
  }
  body.push(el('p', { text: flooded ? 'In a flooded area in this scenario.' : 'Not in a flooded area in this scenario.' }));
  const e = !flooded && shelterReach?.[scenarioKey()]?.[p.id];
  if (e) {
    const i = S.dist === 1 ? 0 : 2;
    body.push(el('p', { text: `About ${approx(e[i])} affected residents within ${S.dist} km (${approx(e[i + 1])} without a car).` }));
  }
  new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(coords).setDOMContent(el('div', {}, body)).addTo(map);
}

function focusSite(k) {
  map.flyTo({ center: k.coords, zoom: Math.max(map.getZoom(), 13.5) });
  map.once('moveend', () => showSitePopup(k.p, k.coords));
}

function focusTract(id) {
  selectTract(id);
  const bb = bboxOf.get(id);
  map.fitBounds(bb, { padding: 60, maxZoom: 14 });
  const c = [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2];
  map.once('moveend', () => showPopup(id, c));
}

// ---- wiring ----------------------------------------------------------------------------------

function buildControls() {
  const view = $('#view');
  for (const o of OVERLAYS) view.append(el('button', { type: 'button', class: 'chip', 'data-v': o.id, text: o.label }));
  $('#bay').addEventListener('input', (e) => { S.bay = +e.target.value; update(); });
  $('#low').addEventListener('change', (e) => { S.low = e.target.checked; update(); });
  $('#rain').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.rain = +b.dataset.v; update(); } });
  $('#dist').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.dist = +b.dataset.v; update({ flood: false }); } });
  for (const box of document.querySelectorAll('[data-show]')) {
    box.addEventListener('change', () => {
      S.show[box.dataset.show] = box.checked;
      if (ready) { applyShow(); if (box.dataset.show === 'roads' && box.checked) applyRoads(); }
      update({ flood: false });
    });
  }
  view.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.view = b.dataset.v;
    if (ready) applyShading();
    update({ flood: false, pts: false });
  });
}

buildControls();
renderControls();
for (const r of REGIONS) $('#regions').append(el('button', { type: 'button', class: 'region', text: r.label, onclick: () => goToRegion(r) }));
$('#legend').open = matchMedia('(min-width: 821px)').matches;

map.on('load', async () => {
  [tracts, scen, points, roadsSummary, shelterReach] = await Promise.all([getJSON('data/tracts.geojson'), getJSON('data/scenarios.json'), getJSON('data/points.json'), getJSON('data/roads_summary.json').catch(() => null), getJSON('data/shelter_reach.json').catch(() => null)]);
  for (const f of tracts.features) {
    byId.set(f.properties.GEOID, f.properties);
    bboxOf.set(f.properties.GEOID, bboxFromGeometry(f.geometry));
  }
  addFloodLayers();
  ready = true;
  applyShading();
  applyShow();
  update();
  map.on('click', 'tracts-fill', (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: POINT_LAYERS }).length) return;
    const id = e.features[0]?.properties.GEOID;
    if (!id) return;
    selectTract(id);
    showPopup(id, e.lngLat);
  });
  map.on('click', POINT_LAYERS, (e) => showSitePopup(e.features[0].properties, e.features[0].geometry.coordinates));
  for (const id of POINT_LAYERS) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('mouseenter', 'tracts-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'tracts-fill', () => { map.getCanvas().style.cursor = ''; });
  document.body.dataset.ready = '1';
});
