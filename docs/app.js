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
};
function clampInt(v, lo, hi, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }

let tracts, scen, ready = false;
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

function scenarioShares() {
  const c = S.bay > 0 && S.low ? 1 : 0;
  return scen.scenarios[`b${S.bay}_r${S.rain}_c${c}`] || {};
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
}

function syncUrl() {
  const p = new URLSearchParams({ b: S.bay, r: S.rain, c: S.low ? 1 : 0, v: S.view });
  history.replaceState(null, '', `?${p}`);
}

function update({ flood = true } = {}) {
  renderControls();
  syncUrl();
  if (!ready) return;
  const r = compute();
  renderSummary(r);
  renderTop(r);
  renderLegend();
  if (flood) applyFlood();
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
  view.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.view = b.dataset.v;
    if (ready) applyShading();
    update({ flood: false });
  });
}

buildControls();
renderControls();
for (const r of REGIONS) $('#regions').append(el('button', { type: 'button', class: 'region', text: r.label, onclick: () => goToRegion(r) }));
$('#legend').open = matchMedia('(min-width: 821px)').matches;

map.on('load', async () => {
  [tracts, scen] = await Promise.all([getJSON('data/tracts.geojson'), getJSON('data/scenarios.json')]);
  for (const f of tracts.features) {
    byId.set(f.properties.GEOID, f.properties);
    bboxOf.set(f.properties.GEOID, bboxFromGeometry(f.geometry));
  }
  addFloodLayers();
  ready = true;
  applyShading();
  update();
  map.on('click', 'tracts-fill', (e) => {
    const id = e.features[0]?.properties.GEOID;
    if (!id) return;
    selectTract(id);
    showPopup(id, e.lngLat);
  });
  map.on('mouseenter', 'tracts-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'tracts-fill', () => { map.getCanvas().style.cursor = ''; });
  document.body.dataset.ready = '1';
});
