'use strict';

// Airport-area detail page. Data: data/ (made by pipeline/13_airport.py) plus the main map's ../data files.

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
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const VARIANT_HINT = {
  mapped: 'Uses the ground heights in the elevation data as they are.',
  hold: 'Assumes the low stretch of shoreline protection along the San Leandro Bay channel at Harbor Bay holds above +3 ft.',
};
const COLORS = { need: '#eb6834', cap: '#2a78d6', cut: '#4a148c', road: '#d03b3b', spill: '#b8860b' };
const KIND = { hospital: 'Hospital', care: 'Care facility', dialysis: 'Dialysis center', fire: 'Fire station', police: 'Police station', pre: 'Pre-identified shelter' };
const SITE_KINDS = new Set(['pre', 'care', 'dialysis', 'fire', 'hospital']);

const q = new URLSearchParams(location.search);
const S = {
  i: Math.min(10, Math.max(0, Math.round(((+q.get('l') || 2) - 2) * 10))),
  variant: q.get('v') === 'hold' ? 'hold' : 'mapped',
  cutRate: [20, 50, 100].includes(+q.get('u')) ? +q.get('u') : 50,
  art: q.get('a') === '1',
  sites: q.get('s') !== '0',
};
let D, points, capacity, ready = false;

const nf = new Intl.NumberFormat('en-US');
const level = () => D.levels[S.i];
const lkey = (L) => L.toFixed(1);
function approx(n) {
  if (n < 0.5) return '0';
  if (n < 10) return '<10';
  const step = n < 1000 ? 10 : 100;
  return '~' + nf.format(Math.round(n / step) * step);
}
const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });

// ---- map -------------------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: [[-122.33, 37.695], [-122.16, 37.795]], fitBoundsOptions: { padding: 20 },
  attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

function makeIcon(shape, fill) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.beginPath();
  if (shape === 'house') { g.moveTo(16, 3); g.lineTo(29, 14); g.lineTo(29, 29); g.lineTo(3, 29); g.lineTo(3, 14); g.closePath(); }
  else if (shape === 'tri') { g.moveTo(16, 3); g.lineTo(30, 28); g.lineTo(2, 28); g.closePath(); }
  else { g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath(); }
  g.lineWidth = 5; g.strokeStyle = '#fff'; g.lineJoin = 'round'; g.stroke(); g.fillStyle = fill; g.fill();
  return g.getImageData(0, 0, 32, 32);
}

function addLayers() {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol').id;
  const add = (layer) => map.addLayer(layer, before);
  const coords = D.image_corners;
  map.addSource('flood', { type: 'image', url: `data/flood/${S.variant}_${lkey(level())}.png`, coordinates: coords });
  map.addSource('art', { type: 'image', url: 'data/art/art_24in.png', coordinates: coords });
  add({ id: 'flood', type: 'raster', source: 'flood', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } });
  add({ id: 'art', type: 'raster', source: 'art', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 } });
  map.addSource('areas', { type: 'geojson', data: 'data/areas.geojson' });
  add({ id: 'areas-fill', type: 'fill', source: 'areas', paint: { 'fill-color': '#7b1fa2', 'fill-opacity': 0.14 } });
  add({ id: 'areas-line', type: 'line', source: 'areas', paint: { 'line-color': COLORS.cut, 'line-width': 2.5, 'line-dasharray': [2, 1.2] } });
  map.addSource('roads', { type: 'geojson', data: 'data/roads.geojson' });
  add({ id: 'roads-casing', type: 'line', source: 'roads', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 5 } });
  add({ id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round' }, paint: { 'line-color': COLORS.road, 'line-width': 3 } });
  map.addImage('ap-house', makeIcon('house', '#006b2e'), { pixelRatio: 2 });
  map.addImage('ap-house-bad', makeIcon('house', '#d03b3b'), { pixelRatio: 2 });
  map.addImage('ap-dia', makeIcon('diamond', '#4a3aa7'), { pixelRatio: 2 });
  map.addImage('ap-dia-bad', makeIcon('diamond', '#d03b3b'), { pixelRatio: 2 });
  map.addImage('ap-tri', makeIcon('tri', COLORS.spill), { pixelRatio: 2 });
  map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const sym = (id, img, filter, size, opacity = 1) => add({ id, type: 'symbol', source: 'sites', filter, layout: { 'icon-image': img, 'icon-size': size, 'icon-allow-overlap': true }, paint: { 'icon-opacity': opacity } });
  const is = (k, v) => ['==', ['get', k], v];
  sym('fac', 'ap-dia', ['all', ['!=', ['get', 'k'], 'pre'], is('f', 0)], 0.4, 0.45);
  sym('fac-bad', 'ap-dia-bad', ['all', ['!=', ['get', 'k'], 'pre'], is('f', 1)], 0.85);
  sym('pre', 'ap-house', ['all', is('k', 'pre'), is('f', 0)], 1);
  sym('pre-bad', 'ap-house-bad', ['all', is('k', 'pre'), is('f', 1)], 1);
  map.addSource('spills', { type: 'geojson', data: 'data/spills.geojson' });
  add({ id: 'spills', type: 'symbol', source: 'spills', filter: ['>=', ['get', 'km2'], 0.03], layout: { 'icon-image': 'ap-tri', 'icon-size': 0.75, 'icon-allow-overlap': true } });
  map.addLayer({
    id: 'areas-label', type: 'symbol', source: 'areas',
    layout: {
      'text-field': ['concat', ['get', 'name'], ': cut off\n', ['number-format', ['get', 'residents'], { locale: 'en-US' }], ' residents'],
      'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-max-width': 14,
    },
    paint: { 'text-color': COLORS.cut, 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
}

function applyMap() {
  const L = level();
  map.getSource('flood').updateImage({ url: `data/flood/${S.variant}_${lkey(L)}.png`, coordinates: D.image_corners });
  const artIn = L < 2.5 ? 24 : 36;
  map.getSource('art').updateImage({ url: `data/art/art_${artIn}in.png`, coordinates: D.image_corners });
  map.setLayoutProperty('art', 'visibility', S.art ? 'visible' : 'none');
  const areaFilter = ['all', ['==', ['get', 'variant'], S.variant], ['==', ['get', 'level'], L]];
  for (const id of ['areas-fill', 'areas-line', 'areas-label']) map.setFilter(id, areaFilter);
  const roadProp = S.variant === 'mapped' ? 'cm' : 'ch';
  const roadFilter = ['all', ['!=', ['get', roadProp], null], ['<=', ['to-number', ['get', roadProp], 99], L + 1e-6]];
  map.setFilter('roads', roadFilter);
  map.setFilter('roads-casing', roadFilter);
  map.setFilter('spills', S.variant === 'hold' ? ['all', ['>=', ['get', 'km2'], 0.03], ['==', ['get', 'held'], 0]] : ['>=', ['get', 'km2'], 0.03]);
  const feats = points.map((f) => {
    const r = D.site_reach[f.properties.id]?.[S.variant];
    return { ...f, properties: { ...f.properties, f: r != null && r <= L ? 1 : 0 } };
  });
  map.getSource('sites').setData({ type: 'FeatureCollection', features: feats });
  for (const id of ['fac', 'fac-bad', 'pre', 'pre-bad']) map.setLayoutProperty(id, 'visibility', S.sites ? 'visible' : 'none');
}

// ---- panel -----------------------------------------------------------------------------------

const stepAt = (L, variant = S.variant) => D.steps[variant][lkey(L)];
const needOf = (ar) => ar.flooded * S.cutRate / 100;

function renderNow() {
  const L = level(), st = stepAt(L);
  const box = $('#now');
  box.replaceChildren(el('h2', { text: `At +${L.toFixed(1)} ft (${S.variant === 'mapped' ? 'as mapped' : 'if embankment holds'})` }));
  box.append(el('div', { class: 'tiles' },
    el('div', { class: 'tile' }, el('div', { class: 'big', text: approx(st.flooded) }), el('div', { class: 'lbl', text: 'residents whose homes flood' })),
    el('div', { class: 'tile' }, el('div', { class: 'big', text: `${st.roads_cut_km} km` }), el('div', { class: 'lbl', text: 'of road under more than 6 in of water' }))));
  if (!st.areas.length) {
    box.append(el('p', { class: 'empty', text: 'No neighborhood is cut off by road at this level.' }));
    return;
  }
  box.append(el('h3', { class: 'sub-h', text: `Cut off by road (${st.areas.length})` }));
  for (const ar of [...st.areas].sort((a, b) => b.residents - a.residents)) {
    const need = needOf(ar), short = need - ar.pre_cap;
    box.append(el('div', { class: 'area' },
      el('div', { class: 'name', text: `${ar.name}: ${nf.format(ar.residents)} residents cut off` }),
      el('div', { class: 'row2', text: `${approx(ar.flooded)} of them in homes that flood; ${approx(need)} would need a shelter at ${S.cutRate}%.` }),
      el('div', { class: 'row2' },
        document.createTextNode(`Pre-identified shelter inside: room for ${nf.format(ar.pre_cap)}. `),
        need >= 0.5 ? el('span', { class: short > 0 ? 'gap-bad' : 'gap-ok', text: short > 0 ? `Short about ${approx(short)}.` : 'Enough room.' }) : null),
      ar.pot_n ? el('div', { class: 'row2', text: `Other dry potential sites inside: ${ar.pot_n}${ar.pot_cap_est ? ` (est. room for ~${nf.format(ar.pot_cap_est)}${ar.pot_no_est ? `, plus ${ar.pot_no_est} without an estimate` : ''})` : ''}.` }) : null,
      ar.care_n || ar.dialysis_n || ar.fire_n ? el('div', { class: 'row2', text: `Inside: ${[ar.care_n && `${ar.care_n} care facilit${ar.care_n > 1 ? 'ies' : 'y'} (${nf.format(ar.care_residents)} licensed residents)`, ar.dialysis_n && `${ar.dialysis_n} dialysis clinic${ar.dialysis_n > 1 ? 's' : ''}`, ar.fire_n && `${ar.fire_n} fire station${ar.fire_n > 1 ? 's' : ''}`].filter(Boolean).join(', ')}.` }) : null,
      ar.cut_roads.length ? el('div', { class: 'row2', text: `Cut by flooding on: ${ar.cut_roads.join(', ')}.` }) : null));
  }
}

let tip;
function renderChart() {
  const box = $('#chart');
  box.replaceChildren(el('h2', { text: 'Shelter need versus room inside cut-off areas' }));
  const series = D.levels.map((L) => {
    const areas = stepAt(L).areas;
    return { L, need: areas.reduce((t, a) => t + needOf(a), 0), cap: areas.reduce((t, a) => t + a.pre_cap, 0), cut: areas.reduce((t, a) => t + a.residents, 0) };
  });
  box.append(el('div', { class: 'chart-legend' },
    el('span', {}, el('span', { class: 'k', style: `background:${COLORS.need}` }), document.createTextNode(`Need a shelter (${S.cutRate}% of flooded homes)`)),
    el('span', {}, el('span', { class: 'k', style: `background:${COLORS.cap}` }), document.createTextNode('Pre-identified shelter room inside'))));
  const W = 360, H = 190, m = { l: 44, r: 12, t: 10, b: 24 };
  const ymax = Math.max(10, ...series.map((s) => Math.max(s.need, s.cap))) * 1.1;
  const x = (L) => m.l + ((L - 2) / 1) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Line chart of shelter need and shelter room inside cut-off areas from +2.0 to +3.0 ft' });
  const grid = svgEl('g', { class: 'grid' }), axis = svgEl('g', { class: 'axis' });
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (ymax / ticks) * i;
    grid.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = nf.format(Math.round(v / 10) * 10); axis.append(t);
  }
  for (const L of [2, 2.5, 3]) {
    const t = svgEl('text', { x: x(L), y: H - 6, 'text-anchor': L === 2 ? 'start' : L === 3 ? 'end' : 'middle' }); t.textContent = `+${L.toFixed(1)} ft`; axis.append(t);
  }
  svg.append(grid, axis);
  svg.append(svgEl('line', { class: 'now', x1: x(level()), x2: x(level()), y1: m.t, y2: H - m.b }));
  for (const [k, color] of [['cap', COLORS.cap], ['need', COLORS.need]]) {
    svg.append(svgEl('polyline', { points: series.map((s) => `${x(s.L)},${y(s[k])}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const s = series[S.i];
    svg.append(svgEl('circle', { cx: x(s.L), cy: y(s[k]), r: 4, fill: color, stroke: '#fff', 'stroke-width': 2 }));
  }
  tip ||= document.body.appendChild(el('div', { class: 'tip' }));
  const step = (W - m.l - m.r) / 10;
  for (const s of series) {
    const r = svgEl('rect', { class: 'hit', x: x(s.L) - step / 2, y: m.t, width: step, height: H - m.t - m.b });
    r.addEventListener('mousemove', (e) => {
      tip.style.display = 'block'; tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY + 12}px`;
      tip.textContent = `+${s.L.toFixed(1)} ft: ${nf.format(s.cut)} residents cut off · need ${approx(s.need)} · room ${nf.format(s.cap)}`;
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    r.addEventListener('click', () => { S.i = D.levels.indexOf(s.L); update(); });
    svg.append(r);
  }
  box.append(el('div', { class: 'chart' }, svg));
}

function renderThresholds() {
  const box = $('#thresholds');
  box.replaceChildren(el('h2', { text: 'When areas get cut off' }));
  const rows = [];
  for (const [variant, label] of [['mapped', 'As mapped'], ['hold', 'If embankment holds']]) {
    const first = {};
    for (const L of D.levels) for (const ar of stepAt(L, variant).areas) if (!(ar.name in first)) first[ar.name] = { L, ar };
    const names = Object.keys(first);
    rows.push(el('h3', { class: 'sub-h', text: label }));
    if (!names.length) rows.push(el('p', { class: 'empty', text: 'No area is cut off by road between +2.0 and +3.0 ft.' }));
    for (const n of names.sort((a, b) => first[a].L - first[b].L)) {
      const { L, ar } = first[n];
      rows.push(el('p', { class: 'note', text: `${n}: cut off from +${L.toFixed(1)} ft (${nf.format(ar.residents)} residents${ar.cut_roads.length ? `; ${ar.cut_roads.slice(0, 3).join(', ')}` : ''}).` }));
    }
  }
  box.append(...rows);
}

function renderSpills() {
  const box = $('#spills');
  box.replaceChildren(el('h2', { text: 'Where water first gets over the shoreline' }));
  box.append(el('p', { class: 'note', text: 'Low points where Bay water spills onto land in this range (triangles on the map). Each is worth checking on the ground or in aerial photos: a tide gate, culvert, or wall missing from the elevation data would change the result.' }));
  const list = el('ol', { class: 'toplist' });
  for (const f of D.spills.filter((s) => s.properties.km2 >= 0.03).sort((a, b) => a.properties.crest - b.properties.crest)) {
    const [lon, lat] = f.geometry.coordinates;
    list.append(el('li', {}, el('button', { type: 'button', onclick: () => map.flyTo({ center: [lon, lat], zoom: 16 }) },
      el('span', {}, el('div', { class: 'place', text: `Spills at +${f.properties.crest.toFixed(1)} ft` }),
        el('div', { class: 'sub2', text: `Opens ${f.properties.km2} km² of land${f.properties.held ? ' · blocked in "if embankment holds"' : ''}` })),
      el('a', { class: 'n', href: `https://www.google.com/maps/@${lat},${lon},19z/data=!3m1!1e3`, target: '_blank', rel: 'noopener', text: 'Satellite', onclick: (e) => e.stopPropagation() }))));
  }
  box.append(list);
}

function renderArt() {
  const box = $('#art');
  box.replaceChildren(el('h2', { text: 'Cross-check with the ART regional map' }));
  const rows = D.art.filter((r) => r.variant === 'as mapped');
  box.append(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { text: 'Bay level' }), el('th', { class: 'num', text: 'ART (km²)' }), el('th', { class: 'num', text: 'This map (km²)' }), el('th', { class: 'num', text: 'Overlap' }))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', { text: `+${(r.inches / 12).toFixed(1)} ft (${r.inches} in)` }),
      el('td', { class: 'num', text: r.art_km2.toFixed(2) }), el('td', { class: 'num', text: r.noaa_km2.toFixed(2) }), el('td', { class: 'num', text: `${Math.round(r.iou * 100)}%` }))))));
  box.append(el('p', { class: 'note', text: 'Flooded land in this map area, comparing the regional ART study with this page\'s "as mapped" result. Overlap is the share of land flooded in either map that is flooded in both. Turn on the ART layer above to compare on the map.' }));
}

function renderLegend() {
  const sw = (cls, style) => el('span', { class: `sw ${cls}`, style });
  const item = (s, t) => el('div', { class: 'row' }, s, el('span', { text: t }));
  const rows = [el('h3', { text: 'Flooding' }), item(sw('', 'background:#2a78d6'), 'Flooded at this level'), item(sw('road', ''), 'Road under more than 6 in of water'),
    item(sw('cut', ''), 'Cut off by road'), item(sw('tri', ''), 'Spill point')];
  if (S.art) rows.push(item(sw('', 'background:#e86834;opacity:.75'), 'ART regional flood map'));
  if (S.sites) rows.push(el('hr'), item(sw('house', 'background:#006b2e'), 'Pre-identified shelter'), item(sw('house', 'background:#d03b3b'), 'Pre-identified shelter, flooded'),
    item(sw('dia', 'background:#4a3aa7'), 'Critical facility'), item(sw('dia', 'background:#d03b3b'), 'Critical facility, flooded'));
  $('#legendBody').replaceChildren(...rows);
}

function renderControls() {
  $('#level').value = S.i;
  $('#levelVal').textContent = `+${level().toFixed(1)} ft`;
  for (const b of $('#variant').children) b.setAttribute('aria-pressed', String(b.dataset.v === S.variant));
  for (const b of $('#cutRate').children) b.setAttribute('aria-pressed', String(+b.dataset.v === S.cutRate));
  $('#variantHint').textContent = VARIANT_HINT[S.variant];
  $('#showArt').checked = S.art;
  $('#showSites').checked = S.sites;
}

function update() {
  renderControls();
  history.replaceState(null, '', `?${new URLSearchParams({ l: level().toFixed(1), v: S.variant, u: S.cutRate, a: S.art ? 1 : 0, s: S.sites ? 1 : 0 })}`);
  applyMap();
  renderNow();
  renderChart();
  renderThresholds();
  renderLegend();
  document.body.dataset.stats = JSON.stringify({ level: level(), variant: S.variant, flooded: stepAt(level()).flooded, areas: stepAt(level()).areas.map((a) => [a.name, a.residents]) });
}

function showSitePopup(p, coords) {
  const L = level(), r = D.site_reach[p.id]?.[S.variant], flooded = r != null && r <= L;
  const cap = capacity?.sites?.[p.id];
  const body = [el('h4', { text: p.n }), el('p', { text: `${KIND[p.k] || p.k}${p.c ? ` · ${p.c}` : ''}` })];
  if (cap) body.push(el('p', { text: `Capacity: ${nf.format(cap[0])} overnight.` }));
  if (p.cap && p.k !== 'pre') body.push(el('p', { text: `${nf.format(p.cap)} licensed ${p.k === 'dialysis' ? 'stations' : p.k === 'hospital' ? 'beds' : 'residents'}.` }));
  body.push(el('p', { class: flooded ? 'warn' : '', text: flooded ? `Flooded at +${L.toFixed(1)} ft.` : r != null && r <= 3 ? `Floods at +${r.toFixed(1)} ft.` : 'Not flooded up to +3.0 ft.' }));
  new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(coords).setDOMContent(el('div', {}, body)).addTo(map);
}

function wire() {
  $('#level').addEventListener('input', (e) => { S.i = +e.target.value; update(); });
  const pick = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { fn(b.dataset.v); update(); } });
  pick('#variant', (v) => { S.variant = v; });
  pick('#cutRate', (v) => { S.cutRate = +v; });
  $('#showArt').addEventListener('change', (e) => { S.art = e.target.checked; update(); });
  $('#showSites').addEventListener('change', (e) => { S.sites = e.target.checked; update(); });
  $('#legend').open = matchMedia('(min-width: 821px)').matches;
  for (const id of ['pre', 'pre-bad', 'fac', 'fac-bad']) {
    map.on('click', id, (e) => showSitePopup(e.features[0].properties, e.features[0].geometry.coordinates));
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

map.on('load', async () => {
  let pts;
  [D, pts, capacity] = await Promise.all([getJSON('data/steps.json'), getJSON('../data/points.json'), getJSON('../data/capacity.json').catch(() => null)]);
  D.spills = (await getJSON('data/spills.geojson')).features;
  const [w, s, e, n] = D.focus;
  points = pts.features.filter((f) => SITE_KINDS.has(f.properties.k)).filter((f) => {
    const [x, y] = f.geometry.coordinates; return x >= w && x <= e && y >= s && y <= n;
  });
  addLayers();
  ready = true;
  wire();
  renderSpills();
  renderArt();
  update();
  document.body.dataset.ready = '1';
});
