// Bici Busão Sampa — live map of the buses and rail lines that carry bicycles in Greater São Paulo.

import { headingOfMove, headingOnRoute, iconTransform } from './heading.js';
import { DEFAULT_VIEW, initLocate } from './locate.js';
import { offsetPolylineClass } from './offset.js';
import { ACCESS, parkingStatus } from './parking.js';
import { initPlanner } from './planner.js';
import { railStatus as lineStatus } from './rail.js';
import { bikeStatus, describeTime } from './schedule.js';
import { holidayName, spParts } from './time.js';
import { initSheets, initUpdates, sheetInsets } from './ui.js';

const RAIL_REFRESH_MS = 60_000;
const BUS_REFRESH_MS = 20_000;
const CLOCK_REFRESH_MS = 15_000;

const STATUS_COLORS = { ok: '#16a34a', wait: '#eab308', closed: '#dc2626' };
// Bus colours (icons, routes, badges) answer two questions at once: are bikes allowed
// on buses at this hour, and does this line usually run superarticulated buses?
//                 usual line          off its usual lines
//   bikes allowed  green               purple
//   outside hours  yellow              orange
// Buses have no "closed" state.
const BUS_COLORS = {
  ok: { expected: '#16a34a', unusual: '#9333ea' },
  wait: { expected: '#eab308', unusual: '#f97316' },
};
const busColor = (status, unusual) => BUS_COLORS[status][unusual ? 'unusual' : 'expected'];
// EMTU seletivo coaches carry the bike in the luggage hold, with no published hours:
// one colour of their own, and boxier icons.
const EMTU_COLOR = '#0e7490';
const isEmtu = (x) => x?.agency === 'emtu';
// Vehicle prefixes are only unique within an operator.
const busId = (bus) => (isEmtu(bus) ? `emtu:${bus.prefix}` : bus.prefix);
const RAIL_DASH = { ok: null, wait: '7 5', closed: '1 6' };
const STATUS_LABELS = { ok: 'Bici liberada', wait: 'Fora do horário da bici', closed: 'Fechada' };

const $ = (sel) => document.querySelector(sel);

// While a planned trip is on the map, the bus and rail lines it doesn't use fade out
// (stops, stations and parking fade as a whole in style.css). null = nothing planned.
// A tapped bus does the same for its own line while its popup is open (busFocus wins
// over the planner's focus, which comes back when the popup closes).
let focus = null; // { buses: Set(code), rails: Set(ref) | null }
let planFocus = null, busFocus = null;
const FADED = 0.2;
const railOpacity = (line) => (focus?.rails && !focus.rails.has(String(line.ref)) ? FADED : 1);
const busOpacity = (code) => (focus && !focus.buses.has(code) ? FADED : 1);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- map

// Rotation (leaflet-rotate): two fingers turning on phones, Shift + wheel with a mouse.
// Lines and tiles turn with the map (they live in its rotatePane); markers stay upright.
// The OSM / data credits live in the menu footer instead of the map corner.
const map = L.map('map', {
  zoomControl: false, preferCanvas: true, attributionControl: false,
  rotate: true, touchRotate: true, rotateControl: false, bearing: 0,
}).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
/** A pane whose content turns with the map: every vector layer (lines) goes in one. */
const rotatingPane = (name) => map.createPane(name, map.getPane('rotatePane'));

// The compass shows while the map is turned; tapping it puts north up again.
const compass = $('#compass-btn');
map.on('rotate', () => {
  const b = map.getBearing();
  compass.hidden = Math.abs(((b + 180) % 360) - 180) < 0.5;
  compass.querySelector('svg').style.transform = `rotate(${b}deg)`;
});
compass.addEventListener('click', () => map.setBearing(0));
// On phones tile layers only load new tiles when a move ends ("updateWhenIdle"), and a
// rotation isn't a move: refresh them once the map stops turning, or corners stay blank.
let tileTimer = null;
map.on('rotate', () => {
  clearTimeout(tileTimer);
  tileTimer = setTimeout(() => map.eachLayer((l) => { if (l instanceof L.TileLayer) l._update(); }), 150);
});
L.control.zoom({ position: 'topleft', zoomInTitle: 'Aproximar', zoomOutTitle: 'Afastar' }).addTo(map);

// Base maps. OSM is desaturated in style.css so the line colours stand out; the
// coloured relief is Pedal Hidrográfico's topo-hydrographic map of Greater SP
// (rmsampa-v2: native tiles at zooms 8–16 inside its bounding box).
const BASE_MAPS = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'osm-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
  topo: L.tileLayer('https://telhas.pedalhidrografi.co/rmsampa-v2/{z}/{x}/{y}.png', {
    maxZoom: 19,
    minNativeZoom: 8,
    maxNativeZoom: 16,
    bounds: [[-24.207, -47.461], [-22.918, -45.703]],
    attribution: 'Topografia colorida · <a href="https://amora.pedalhidrografi.co/">Pedal Hidrográfico</a>',
  }),
};
// Base maps stack (bottom to top, in this order), each with its own opacity.
const BASE_LABELS = { osm: 'OpenStreetMap', topo: 'Topográfico colorido' };
// On phones the relief starts off: two tile layers double the images to load and draw.
const BASE_DEFAULTS = { osm: { on: true, opacity: 1 }, topo: { on: !matchMedia('(max-width: 640px)').matches, opacity: 0.2 } };
let baseState = structuredClone(BASE_DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('baseMaps') ?? 'null');
  if (saved) for (const key of Object.keys(baseState)) Object.assign(baseState[key], saved[key]);
} catch {}
const rememberBases = () => { try { localStorage.setItem('baseMaps', JSON.stringify(baseState)); } catch {} };
Object.keys(BASE_MAPS).forEach((key, i) => {
  BASE_MAPS[key].setZIndex(i + 1).setOpacity(baseState[key].opacity);
  if (baseState[key].on) BASE_MAPS[key].addTo(map);
});

rotatingPane('tracks').style.zIndex = 405;
// Wider click tolerance so the thin rails are easy to tap.
const trackRenderer = L.canvas({ pane: 'tracks', tolerance: 6 });
rotatingPane('busRoutes').style.zIndex = 410;
const busRouteRenderer = L.canvas({ pane: 'busRoutes', tolerance: 4 });
map.createPane('busStops').style.zIndex = 415;
map.createPane('parking').style.zIndex = 418;
map.createPane('stations').style.zIndex = 420;

const trackLayer = L.layerGroup();
const stationLayer = L.layerGroup();
const busRouteLayer = L.layerGroup();
const busStopLayer = L.layerGroup();
const busLayer = L.layerGroup();
const bicicletarioLayer = L.layerGroup();
const paracicloLayer = L.layerGroup();

// Stations, stops and bike parking only appear when zoomed in, inside a group the
// user can toggle. Bicicletários (few, big) show up before paraciclos (many, small).
const stationGroup = L.layerGroup();
const busStopGroup = L.layerGroup();
const parkingGroup = L.layerGroup();
const BUS_STOP_MIN_ZOOM = 14;
const PARKING_MIN_ZOOM = 12;
const ZOOMED_LAYERS = [
  [stationLayer, stationGroup, 12],
  [busStopLayer, busStopGroup, BUS_STOP_MIN_ZOOM],
  [bicicletarioLayer, parkingGroup, PARKING_MIN_ZOOM],
  [paracicloLayer, parkingGroup, 14],
];

function updateZoomedLayers() {
  for (const [layer, group, minZoom] of ZOOMED_LAYERS) {
    if (map.getZoom() >= minZoom) group.addLayer(layer);
    else group.removeLayer(layer);
  }
}

// Layer control entries: [storage key, label, layer].
const TOGGLES = [
  ['rail', 'Metrô e trens', trackLayer],
  ['stations', 'Estações', stationGroup],
  ['busRoutes', 'Itinerários de ônibus', busRouteLayer],
  ['buses', 'Ônibus ao vivo', busLayer],
  ['busStops', 'Pontos de ônibus', busStopGroup],
  ['parking', 'Bicicletários e paraciclos', parkingGroup],
];

let hidden = [];
try { hidden = JSON.parse(localStorage.getItem('hiddenLayers') ?? '[]'); } catch {}
for (const [key, , layer] of TOGGLES) if (!hidden.includes(key)) layer.addTo(map);

function rememberLayers() {
  const off = TOGGLES.filter(([, , layer]) => !map.hasLayer(layer)).map(([key]) => key);
  try { localStorage.setItem('hiddenLayers', JSON.stringify(off)); } catch {}
}

// The layers sheet (⧉): base map as radio buttons, overlays as switches. Adding a
// layer fires 'overlayadd' like L.control.layers did, which lazy layers listen to.
function buildLayerRows() {
  // Top layer first, as it's drawn.
  const bases = Object.entries(BASE_LABELS).reverse().map(([key, label]) => `
    <li class="base-row"><label><input type="checkbox" data-base="${key}" ${baseState[key].on ? 'checked' : ''}><span>${label}</span></label>
      <input type="range" min="0" max="100" step="5" value="${Math.round(baseState[key].opacity * 100)}" data-opacity="${key}" aria-label="Opacidade: ${label}">
      <output>${Math.round(baseState[key].opacity * 100)}%</output></li>`);
  const overlays = TOGGLES.map(([key, label, layer]) => `
    <li><label><input type="checkbox" data-layer="${key}" ${map.hasLayer(layer) ? 'checked' : ''}><span>${label}</span></label></li>`);
  $('#layer-rows').innerHTML = `<li class="layer-group">Mapa</li>${bases.join('')}<li class="layer-group">No mapa</li>${overlays.join('')}`;
}
buildLayerRows();
$('#layer-rows').addEventListener('input', (e) => {
  const key = e.target.dataset.opacity;
  if (!key) return;
  baseState[key].opacity = Number(e.target.value) / 100;
  BASE_MAPS[key].setOpacity(baseState[key].opacity);
  e.target.nextElementSibling.textContent = `${e.target.value}%`;
  rememberBases();
});
$('#layer-rows').addEventListener('change', (e) => {
  const input = e.target;
  if (input.dataset.base) {
    const key = input.dataset.base;
    baseState[key].on = input.checked;
    if (input.checked) BASE_MAPS[key].addTo(map);
    else BASE_MAPS[key].remove();
    rememberBases();
    return;
  }
  if (input.dataset.opacity) return; // handled on 'input'
  const layer = TOGGLES.find(([key]) => key === input.dataset.layer)?.[2];
  if (!layer) return;
  if (input.checked) {
    layer.addTo(map);
    map.fire('overlayadd', { layer });
  } else {
    layer.remove();
    map.fire('overlayremove', { layer });
  }
  rememberLayers();
});
map.on('zoomend', updateZoomedLayers);
// Bus icons shrink as you zoom out so busy corridors don't turn into a pile.
const BUS_SCALE = { 10: 0.45, 11: 0.55, 12: 0.7, 13: 0.85 };
const setBusScale = () => {
  const z = Math.round(map.getZoom());
  map.getContainer().style.setProperty('--bus-scale', z >= 14 ? 1 : BUS_SCALE[Math.max(10, z)]);
};
map.on('zoomend', setBusScale);
setBusScale();
updateZoomedLayers();

// ---------------------------------------------------------------- data

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Start every download at once. Only the two small config files block the first
// render; the map layers are drawn whenever they arrive.
const railGeoPromise = getJson('data/rail.geojson').catch(() => ({ features: [] }));
const busGeoPromise = getJson('data/bus-routes.geojson').catch(() => ({ features: [] }));
const emtuGeoPromise = getJson('data/emtu-routes.geojson').catch(() => ({ features: [] }));
const [railConfig, busConfig, emtuConfig] = await Promise.all([
  getJson('data/rail-lines.json'),
  getJson('data/bike-buses.json'),
  getJson('data/emtu-seletivo.json').catch(() => ({ lines: [], rules: {} })),
]);

const state = {
  live: {}, // ref -> { code, status, description }
  buses: [], // SPTrans 23m buses, then EMTU seletivo coaches (agency: 'emtu')
  busError: null,
  emtuError: null,
  busesLoaded: false,
};

// ---------------------------------------------------------------- rail

// Official Metrô / CPTM symbols; interchanges between the two show both.
const stationIcons = new Map();
function stationIcon(modes) {
  const key = modes.join('+') || 'metro';
  if (!stationIcons.has(key)) {
    const imgs = (modes.length ? modes : ['metro'])
      .map((m) => `<img src="icons/${m === 'train' ? 'cptm' : 'metro'}.svg" alt="">`).join('');
    const n = Math.max(1, modes.length);
    stationIcons.set(key, L.divIcon({
      className: 'station-icon',
      html: imgs,
      // Padded to a 32 px tap target around the 16 px symbols.
      iconSize: [16 * n + 2 * (n - 1) + 16, 32],
      iconAnchor: [(16 * n + 2 * (n - 1) + 16) / 2, 16],
    }));
  }
  return stationIcons.get(key);
}

function railStatus(line, date = new Date()) {
  return lineStatus(line, railConfig.bikeRules.bikes, state.live[line.ref], date);
}

const lines = railConfig.lines.map((line) => ({ ...line, tracks: [], bounds: null }));
const lineByRef = new Map(lines.map((l) => [l.ref, l]));

function addRailGeometry(railGeo) {
  for (const f of railGeo.features) {
    if (f.properties.kind === 'track') {
      const line = lineByRef.get(f.properties.ref);
      if (!line) continue;
      const latlngs = f.geometry.coordinates.map((part) => part.map(([lon, lat]) => [lat, lon]));
      // Thin continuous line in the bike status colour (set in renderRail).
      const track = L.polyline(latlngs, { renderer: trackRenderer, weight: 2.5, opacity: railOpacity(line), lineCap: 'round', bubblingMouseEvents: false });
      track.on('click', (e) => L.popup().setLatLng(e.latlng).setContent(linePopup(line)).openOn(map));
      trackLayer.addLayer(track);
      line.tracks.push(track);
      line.bounds = track.getBounds();
    } else if (f.properties.kind === 'station') {
      const [lon, lat] = f.geometry.coordinates;
      const refs = f.properties.refs.filter((r) => lineByRef.has(r));
      const modes = [...new Set(refs.map((r) => lineByRef.get(r).mode))].sort(); // metro before train
      L.marker([lat, lon], { pane: 'stations', icon: stationIcon(modes), keyboard: false })
        .bindTooltip(esc(f.properties.name), { direction: 'top', offset: [0, -8] })
        .bindPopup(() => `<h3>${esc(f.properties.name)}</h3>${refs.map((r) => lineRow(lineByRef.get(r))).join('')}`)
        .addTo(stationLayer);
    }
  }
  renderRail();
}

function badge(line) {
  return `<span class="badge" style="background:${line.color}">${esc(line.ref)}</span>`;
}

function lineRow(line) {
  const s = railStatus(line);
  return `<p style="margin:4px 0">${badge(line)} <span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}</p>`;
}

function linePopup(line) {
  const s = railStatus(line);
  return `<h3>${badge(line)} ${esc(line.name)}</h3>
    <p style="margin:0">${esc(line.operator)}</p>
    <p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> <b>${STATUS_LABELS[s.status]}</b><br>${esc(s.detail)}</p>
    ${s.live ? `<p style="margin:6px 0 0">⚠️ ${esc(s.live)}</p>` : ''}
    ${s.note ? `<p style="margin:6px 0 0;color:var(--muted)">${esc(s.note)}</p>` : ''}`;
}

function renderRail() {
  const now = new Date();
  const items = lines.map((line) => {
    const s = railStatus(line, now);
    // Dashes too, not just colour: solid = bikes allowed, dashed = outside hours,
    // dotted = closed.
    for (const t of line.tracks) t.setStyle({ color: STATUS_COLORS[s.status], dashArray: RAIL_DASH[s.status] });
    const extra = s.live;
    return `<li data-ref="${esc(line.ref)}">
      ${badge(line)}
      <span class="dot ${s.status}" title="${STATUS_LABELS[s.status]}"></span>
      <span><span class="name">${esc(line.name)}</span>
        <span class="detail">${esc(s.detail)}</span>
        ${extra ? `<span class="detail clamp" title="${esc(extra)}">⚠️ ${esc(extra)}</span>` : ''}</span>
    </li>`;
  });
  $('#rail-list').innerHTML = items.join('');
}

$('#rail-list').addEventListener('click', (e) => {
  const line = lineByRef.get(e.target.closest('li')?.dataset.ref);
  if (!line?.bounds) return;
  map.fitBounds(line.bounds, { padding: [40, 40] });
  L.popup().setLatLng(line.bounds.getCenter()).setContent(linePopup(line)).openOn(map);
});

async function refreshLive() {
  try {
    state.live = (await getJson('api/rail-status')).lines ?? {};
  } catch (err) {
    console.warn('rail status unavailable', err);
  }
  renderRail();
}

// ---------------------------------------------------------------- buses

// Expected lines come from the config; lines a bike-rack bus runs unexpectedly are
// added on the fly (`unusual`). `shapes` maps Olho Vivo "sentido" (1 or 2) to the
// route as [[lat, lon], ...] in travel order.
const newLine = (props) => ({ routes: [], shapes: {}, bounds: null, ...props });
// EMTU line codes ("280", "218EX1") never look like SPTrans ones ("1178-10").
const busLineByCode = new Map([
  ...busConfig.lines.map((l) => [l.code, newLine(l)]),
  ...emtuConfig.lines.map((l) => [l.code, newLine({ ...l, agency: 'emtu' })]),
]);

// Bike status of buses right now ('ok' or 'wait'), refreshed by renderBuses().
let busNow = 'ok';
const lineColor = (line) => (isEmtu(line) ? EMTU_COLOR : busColor(busNow, line?.unusual));

const OffsetPolyline = offsetPolylineClass(L);
// Routes are drawn 10 m wide on the ground, but never thinner than 1.5 px so they
// stay visible when zoomed out. Lane n sits beside the street centre, right of the
// direction of travel, so lines sharing a street lie side by side. Lanes are
// assigned by scripts/build-data.mjs.
const ROUTE_METERS = 10;
const MIN_ROUTE_PX = 1.5;
// Metres per pixel at São Paulo's latitude (Web Mercator).
const metersPerPixel = (zoom) => (156_543.03 * Math.cos((-23.55 * Math.PI) / 180)) / 2 ** zoom;
const routeWeight = (zoom) => Math.max(MIN_ROUTE_PX, ROUTE_METERS / metersPerPixel(zoom));
const laneOffset = (lane, zoom) => (lane + 0.6) * routeWeight(zoom);
// The route of a tapped bus (its direction) is drawn thicker, on top of the others.
let highlighted = null; // { code, sentido }
const HIGHLIGHT_PX = 5;
const isHighlighted = (r) => highlighted && r.lineCode === highlighted.code
  && (highlighted.sentido == null || r.sentido === highlighted.sentido);
const weightOf = (r) => routeWeight(map.getZoom()) + (isHighlighted(r) ? HIGHLIGHT_PX : 0);
map.on('zoomend', () => busRouteLayer.eachLayer((r) => r.setStyle({ weight: weightOf(r) })));

function addRoute(line, sentido, coordinates, lane, headsign) {
  const latlngs = coordinates.map(([lon, lat]) => [lat, lon]);
  if (latlngs.length < 2) return;
  line.shapes[sentido] = latlngs;
  const route = new OffsetPolyline(latlngs, {
    renderer: busRouteRenderer,
    weight: routeWeight(map.getZoom()),
    opacity: busOpacity(line.code),
    offset: (zoom) => laneOffset(lane, zoom),
    color: lineColor(line),
  }).bindTooltip(`${esc(line.code)}${headsign ? ` → ${esc(headsign)}` : ''}`, { sticky: true });
  route.lineCode = line.code;
  route.sentido = sentido;
  busRouteLayer.addLayer(route);
  if (isHighlighted(route)) { route.setStyle({ weight: weightOf(route) }); route.bringToFront(); }
  line.routes.push(route);
  line.bounds = line.bounds ? line.bounds.extend(route.getBounds()) : route.getBounds();
}

function addBusRoutes(busGeo) {
  for (const f of busGeo.features) {
    const line = busLineByCode.get(f.properties.code);
    if (!line) continue;
    if (f.properties.fare) line.fare = f.properties.fare; // EMTU
    addRoute(line, f.properties.sentido, f.geometry.coordinates, f.properties.lane ?? 0, f.properties.headsign);
  }
}

/**
 * Fetches and draws the route and stops of an unusual line (once): from the
 * per-line GTFS file, else from GeoSampa (routes only) for lines missing there.
 */
async function loadUnusualRoute(line) {
  line.routeRequested ??= getJson(`data/lines/${encodeURIComponent(line.code)}.json`)
    .catch(() => getJson(`api/route?line=${encodeURIComponent(line.code)}`))
    .then((data) => {
      if (!busLineByCode.has(line.code)) return; // dropped while loading
      if (data.name) line.name = data.name;
      for (const d of data.directions ?? []) addRoute(line, d.sentido, d.coordinates, 0, d.headsign);
      addStops((data.stops ?? []).map((st) => ({ ...st, lines: [line.code] })));
      line.stopIds = (data.stops ?? []).map((st) => st.id);
    })
    .catch((err) => console.warn(`route ${line.code} unavailable`, err));
  return line.routeRequested;
}

function dropUnusualLine(line) {
  for (const r of line.routes) busRouteLayer.removeLayer(r);
  removeStopsOfLine(line.code, line.stopIds ?? []);
  busLineByCode.delete(line.code);
}

// Bus stop: a bus seen from the front.
const busStopIcon = L.divIcon({
  className: 'bus-stop-icon',
  html: `<svg viewBox="0 0 14 16" width="14" height="16" aria-hidden="true">
    <rect x="1" y="0.8" width="12" height="12.4" rx="2.2" fill="#1c1917" stroke="#fff" stroke-width="1"/>
    <rect x="2.8" y="2.6" width="8.4" height="5" rx=".8" fill="#fff"/>
    <circle cx="3.9" cy="10.3" r="1" fill="#fde68a"/><circle cx="10.1" cy="10.3" r="1" fill="#fde68a"/>
    <rect x="2.2" y="12.6" width="2.4" height="2.8" rx=".7" fill="#1c1917" stroke="#fff" stroke-width=".8"/>
    <rect x="9.4" y="12.6" width="2.4" height="2.8" rx=".7" fill="#1c1917" stroke="#fff" stroke-width=".8"/>
  </svg>`,
  iconSize: [32, 32], // tap target around the 14×16 icon
  iconAnchor: [16, 16],
});

// Thousands of stops: those of the expected lines are downloaded the first time
// someone zooms in with the layer on; unusual lines add theirs as they load. Only
// the stops in view are on the map.
const stopIndex = new Map(); // stop id -> { marker, name, lines: Set }
let expectedStopsLoading = null;

function addStops(stops) {
  for (const { id, name, coordinates, lines } of stops) {
    const known = stopIndex.get(id);
    if (known) {
      lines.forEach((c) => known.lines.add(c));
      continue;
    }
    const [lon, lat] = coordinates;
    const entry = { name, lines: new Set(lines) };
    entry.marker = L.marker([lat, lon], { pane: 'busStops', icon: busStopIcon, keyboard: false })
      .bindTooltip(esc(name), { direction: 'top', offset: [0, -8] })
      .bindPopup(() => busStopPopup(entry));
    stopIndex.set(id, entry);
  }
  showStopsInView();
}

function removeStopsOfLine(code, ids) {
  for (const id of ids) {
    const entry = stopIndex.get(id);
    if (!entry) continue;
    entry.lines.delete(code);
    if (!entry.lines.size) {
      busStopLayer.removeLayer(entry.marker);
      stopIndex.delete(id);
    }
  }
}

function loadExpectedStops() {
  expectedStopsLoading ??= Promise.all(['data/bus-stops.geojson', 'data/emtu-stops.geojson'].map((url) => getJson(url)
    .then((geo) => addStops(geo.features.map((f) => ({ ...f.properties, coordinates: f.geometry.coordinates }))))
    .catch((err) => console.warn(`${url} unavailable`, err))));
}

function showStopsInView() {
  if (!map.hasLayer(busStopGroup) || map.getZoom() < BUS_STOP_MIN_ZOOM) return;
  loadExpectedStops();
  const view = map.getBounds().pad(0.25);
  for (const { marker } of stopIndex.values()) {
    const inView = view.contains(marker.getLatLng());
    if (inView && !busStopLayer.hasLayer(marker)) busStopLayer.addLayer(marker);
    else if (!inView && busStopLayer.hasLayer(marker)) busStopLayer.removeLayer(marker);
  }
}
map.on('moveend overlayadd', showStopsInView);

function busStopPopup({ name, lines }) {
  const s = bikeStatus({ bikes: busConfig.rules.bikes });
  const codes = [...lines].sort();
  const rows = codes.map((code) => {
    const line = busLineByCode.get(code);
    const n = state.buses.filter((b) => b.line === code).length;
    return `<p style="margin:4px 0">${busBadge(code)} ${esc(line?.name ?? '')}${n ? ` · ${n} ${isEmtu(line) ? 'ao vivo' : 'com suporte agora'}` : ''}</p>`;
  });
  const emtu = codes.some((c) => isEmtu(busLineByCode.get(c)));
  const sptrans = codes.some((c) => !isEmtu(busLineByCode.get(c)));
  return `<h3>Ponto: ${esc(name)}</h3>${rows.join('')}
    ${sptrans ? `<p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}</p>` : ''}
    ${emtu ? `<p style="margin:6px 0 0">${esc(emtuConfig.rules.summary)}</p>` : ''}`;
}

function busBadge(code) {
  return `<span class="badge" style="background:${lineColor(busLineByCode.get(code))}">${esc(code)}</span>`;
}

// A box in the bus colour with an arrow pointing right; turned by iconTransform()
// to point the way the bus is going.
// Outside bike hours the outline is dashed, so the status doesn't rely on colour alone.
// EMTU coaches get square corners.
const busSvg = (body, ink, dashed, corner = 3) => `<svg class="bus-icon" viewBox="0 0 26 14" width="26" height="14" aria-hidden="true">
  <rect x="1" y="1" width="24" height="12" rx="${corner}" fill="${body}" stroke="${ink}" stroke-width="2"${dashed ? ' stroke-dasharray="3 2"' : ''}/>
  <path d="M6 7h11M13.5 3.6 17.5 7l-4 3.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const busIcons = new Map();
/** `status` is the SPTrans bike status, or 'emtu' for a seletivo coach. */
function busIcon(status, unusual) {
  const key = `${status}|${unusual}`;
  if (!busIcons.has(key)) {
    busIcons.set(key, L.divIcon({
      className: 'bus-marker',
      html: status === 'emtu' ? busSvg(EMTU_COLOR, '#1c1917', false, 0.8) : busSvg(busColor(status, unusual), '#1c1917', status !== 'ok'),
      // A 40 px box around the small icon: what the finger hits.
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -10],
    }));
  }
  return busIcons.get(key);
}

const lastPosition = new Map(); // prefix -> [lat, lon]
const lastHeading = new Map(); // prefix -> angle

/** Direction the bus is travelling: along its route shape, else from its last move. */
function busHeading(bus) {
  const here = [bus.lat, bus.lon];
  const line = busLineByCode.get(bus.line);
  const shape = line?.shapes[bus.sentido] ?? Object.values(line?.shapes ?? {})[0];
  const onRoute = shape && headingOnRoute(here, shape);
  let angle = onRoute && onRoute.distance < 60 ? onRoute.angle : null;
  const id = busId(bus);
  const prev = lastPosition.get(id);
  angle ??= prev ? headingOfMove(prev, here) : null;
  angle ??= lastHeading.get(id) ?? null;
  lastPosition.set(id, here);
  if (angle != null) lastHeading.set(id, angle);
  return angle;
}

const busMarkers = new Map(); // busId -> marker

const fare = (n) => `R$ ${n.toFixed(2).replace('.', ',')}`;

function busPopup(bus, s) {
  const line = busLineByCode.get(bus.line);
  const seen = bus.at ? new Date(bus.at) : null;
  const emtu = isEmtu(bus);
  const rule = emtu
    ? `<p style="margin:6px 0 0"><b>Seletivo EMTU</b>${line?.operator ? ` · ${esc(line.operator)}` : ''}${line?.fare ? ` · ${fare(line.fare)}` : ''}<br>${esc(emtuConfig.rules.summary)}</p>`
    : `<p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> <b>${STATUS_LABELS[s.status]}</b><br>${esc(s.detail)}</p>`;
  return `<h3>Ônibus ${esc(bus.prefix)}</h3>
    <p style="margin:0">${busBadge(bus.line)} → ${esc(bus.to)}</p>
    ${line?.name ? `<p style="margin:2px 0 0;color:var(--muted)">${esc(line.name)}</p>` : ''}
    ${bus.expected ? '' : '<p style="margin:6px 0 0">⚠️ Fora da rota habitual</p>'}
    ${rule}
    ${bus.accessible ? '<p style="margin:6px 0 0">♿ Acessível</p>' : ''}
    ${seen ? `<p style="margin:0;color:var(--muted)">Posição das ${describeTime(seen)}</p>` : ''}
    ${line?.note ? `<p style="margin:6px 0 0">⚠️ ${esc(line.note)}</p>` : ''}`;
}

function lineItem(code, n) {
  const line = busLineByCode.get(code);
  const what = isEmtu(line) ? 'ao vivo' : 'com suporte';
  const count = !state.busesLoaded ? 'carregando posições…'
    : n ? `${n} ônibus ${what} agora` : `nenhum ônibus ${what} agora`;
  return `<li data-code="${esc(code)}">
    ${busBadge(code)}
    <span><span class="name">${esc(line?.name ?? '')}</span>
      <span class="detail">${count}</span>
      ${line?.note ? `<span class="detail">⚠️ ${esc(line.note)}</span>` : ''}</span>
  </li>`;
}

function renderBuses() {
  const s = bikeStatus({ bikes: busConfig.rules.bikes });
  if (s.status !== busNow) {
    busNow = s.status;
    for (const line of busLineByCode.values()) line.routes.forEach((r) => r.setStyle({ color: lineColor(line) }));
  }
  const counts = new Map();
  for (const bus of state.buses) {
    counts.set(bus.line, (counts.get(bus.line) ?? 0) + 1);
    if (!bus.expected && !busLineByCode.has(bus.line)) {
      busLineByCode.set(bus.line, newLine({ code: bus.line, name: `${bus.from} – ${bus.to}`, unusual: true }));
    }
  }
  for (const line of [...busLineByCode.values()]) {
    if (!line.unusual) continue;
    if (counts.has(line.code)) loadUnusualRoute(line).then(() => renderBusMarkers(s));
    else dropUnusualLine(line);
  }
  renderBusMarkers(s);

  const byCount = (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
  const sptrans = [...busLineByCode.values()].filter((l) => !isEmtu(l));
  const expected = sptrans.filter((l) => !l.unusual).map((l) => l.code).sort(byCount);
  const unusual = sptrans.filter((l) => l.unusual).map((l) => l.code).sort(byCount);
  const active = expected.filter((c) => counts.has(c)).length;
  const sptransLive = state.buses.filter((b) => !isEmtu(b)).length;

  $('#bus-count').textContent = state.busesLoaded && !state.busError ? `· ${sptransLive} ao vivo` : '';
  $('#bus-status').innerHTML = `<span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}`
    + (state.busError ? '<br><b>Sem posições ao vivo agora</b>' : '');
  $('#bus-unusual').hidden = !unusual.length;
  const offRoute = unusual.reduce((n, c) => n + (counts.get(c) ?? 0), 0);
  $('#bus-unusual-summary').textContent = `Fora da rota habitual (${offRoute} ônibus em ${unusual.length} ${unusual.length === 1 ? 'linha' : 'linhas'})`;
  $('#bus-unusual-list').innerHTML = unusual.map((c) => lineItem(c, counts.get(c))).join('');
  $('#bus-lines-summary').textContent = `Linhas habituais (${active} de ${expected.length} com ônibus agora)`;
  $('#bus-list').innerHTML = expected.map((c) => lineItem(c, counts.get(c))).join('');

  const emtu = [...busLineByCode.values()].filter(isEmtu).map((l) => l.code).sort(byCount);
  const emtuLive = state.buses.filter(isEmtu).length;
  $('#emtu-count').textContent = state.busesLoaded && !state.emtuError ? `· ${emtuLive} ao vivo` : '';
  $('#emtu-status').innerHTML = esc(emtuConfig.rules.summary) + (state.emtuError ? '<br><b>Sem posições ao vivo agora</b>' : '');
  $('#emtu-list').innerHTML = emtu.map((c) => lineItem(c, counts.get(c))).join('');
}

// Only the buses in view get a marker (hundreds of DOM icons make panning and zooming
// slow on phones), and none when zoomed out past BUS_MIN_ZOOM. Popups are built when
// opened, not on every refresh.
const BUS_MIN_ZOOM = 12;
let busStatusNow = null; // bike status of buses at the last refresh
const busById = new Map(); // busId -> latest vehicle
const busHeadings = new Map(); // busId -> angle (math convention) or null

function renderBusMarkers(s) {
  busStatusNow = s;
  busById.clear();
  for (const bus of state.buses) {
    busById.set(busId(bus), bus);
    busHeadings.set(busId(bus), busHeading(bus)); // tracks every bus, shown or not
  }
  syncBusMarkers();
}

function syncBusMarkers() {
  const s = busStatusNow;
  if (!s) return;
  const view = map.hasLayer(busLayer) && map.getZoom() >= BUS_MIN_ZOOM ? map.getBounds().pad(0.2) : null;
  const shown = new Set();
  if (view) {
    const bearing = map.getBearing();
    for (const [id, bus] of busById) {
      if (!view.contains([bus.lat, bus.lon])) continue;
      shown.add(id);
      const icon = busIcon(isEmtu(bus) ? 'emtu' : s.status, !bus.expected);
      let marker = busMarkers.get(id);
      if (!marker) {
        marker = L.marker([bus.lat, bus.lon], { keyboard: false, icon })
          .bindPopup(() => busPopup(busById.get(id) ?? bus, busStatusNow))
          .on('popupopen', () => highlightBus(busById.get(id) ?? bus))
          .on('popupclose', () => highlightBus(null))
          .addTo(busLayer);
        busMarkers.set(id, marker);
      } else {
        marker.setLatLng([bus.lat, bus.lon]);
        if (marker.isPopupOpen()) marker.getPopup().update();
      }
      if (marker.options.icon !== icon) marker.setIcon(icon);
      marker.setOpacity(busOpacity(bus.line));
      const svg = marker.getElement()?.querySelector('.bus-icon');
      if (svg) {
        const heading = busHeadings.get(id);
        svg.dataset.heading = heading ?? '';
        svg.style.transform = iconTransform(heading == null ? null : heading - bearing);
      }
    }
  }
  for (const [id, marker] of busMarkers) {
    if (!shown.has(id)) {
      marker.remove();
      busMarkers.delete(id);
    }
  }
}
map.on('moveend overlayadd', syncBusMarkers);

async function showBusLine(e) {
  const code = e.target.closest('li[data-code]')?.dataset.code;
  const line = busLineByCode.get(code);
  if (!line) return;
  if (line.unusual) await loadUnusualRoute(line);
  let bounds = line.bounds;
  for (const b of state.buses.filter((x) => x.line === code)) bounds = bounds ? bounds.extend([b.lat, b.lon]) : L.latLngBounds([[b.lat, b.lon]]);
  if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  for (const r of line.routes) r.setStyle({ weight: routeWeight(map.getZoom()) + 3 });
  setTimeout(() => line.routes.forEach((r) => r.setStyle({ weight: routeWeight(map.getZoom()) })), 2500);
}
$('#bus-section').addEventListener('click', showBusLine);
$('#emtu-section').addEventListener('click', showBusLine);

// SPTrans and EMTU come from separate feeds: either can fail without hiding the other.
let sptransBuses = [], emtuBuses = [];
async function refreshBuses() {
  const [sptrans, emtu] = await Promise.allSettled([getJson('api/buses'), getJson('api/emtu-buses')]);
  const vehicles = (r) => {
    if (r.status === 'rejected') throw r.reason;
    if (r.value.error) throw new Error(r.value.error);
    return r.value.vehicles ?? [];
  };
  try {
    sptransBuses = vehicles(sptrans);
    state.busError = null;
  } catch (err) {
    state.busError = err.message;
  }
  try {
    emtuBuses = vehicles(emtu);
    state.emtuError = null;
  } catch (err) {
    state.emtuError = err.message;
  }
  state.buses = [...sptransBuses, ...emtuBuses];
  state.busesLoaded = true;
  renderBuses();
}

// ---------------------------------------------------------------- bike parking

// Colour = can I leave my bike here now, and on what terms. Shape = kind: a circle
// for a paraciclo (stands), a house for a bicicletário (covered, usually staffed).
const PARKING_COLORS = { livre: '#16a34a', cadastro: '#2563eb', pago: '#db2777', clientes: '#78716c', closed: '#dc2626' };
// A white inverted-U stand (the paraciclo symbol) in a circle or a house, outlined in
// dark ink like the bus icons so green spots stand out on green bus routes.
const PARKING_SHAPES = {
  paraciclo: { size: 20, outline: '<circle cx="12" cy="12" r="10"/>', stand: 0 },
  bicicletario: { size: 25, outline: '<path d="M12 1.6 22.6 10.2V21a1.4 1.4 0 0 1-1.4 1.4H2.8A1.4 1.4 0 0 1 1.4 21V10.2Z"/>', stand: 1.6 },
};
// Closed spots also get a diagonal bar, so "closed" doesn't rely on red alone.
const parkingSvg = (kind, fill, closed = false) => {
  const { size, outline, stand } = PARKING_SHAPES[kind];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <g fill="${fill}" stroke="#1c1917" stroke-width="1.6">${outline}</g>
    <path d="M8.6 16.4V11.4a3.4 3.4 0 0 1 6.8 0v5M6.6 16.6h10.8" transform="translate(0 ${stand})" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    ${closed ? '<path d="M4.5 19.5 19.5 4.5" stroke="#1c1917" stroke-width="4.2" stroke-linecap="round"/><path d="M4.5 19.5 19.5 4.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/>' : ''}
  </svg>`;
};
for (const el of document.querySelectorAll('[data-parking-shape]')) el.innerHTML = parkingSvg(el.dataset.parkingShape, '#78716c');

const parkingIcons = new Map();
function parkingIcon(kind, colorKey) {
  const key = `${kind}|${colorKey}`;
  if (!parkingIcons.has(key)) {
    const { size } = PARKING_SHAPES[kind];
    parkingIcons.set(key, L.divIcon({
      className: 'parking-icon',
      html: parkingSvg(kind, PARKING_COLORS[colorKey], colorKey === 'closed'),
      iconSize: [36, 36], // tap target around the icon
      iconAnchor: [18, 18],
    }));
  }
  return parkingIcons.get(key);
}

function parkingPopup(p) {
  const s = parkingStatus(p);
  const facts = [p.operator, p.capacity && `${p.capacity} vagas`, p.covered && 'coberto'].filter(Boolean);
  const source = p.osm
    ? `<a href="https://www.openstreetmap.org/${esc(p.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>`
    : 'GeoSampa (Prefeitura de SP)';
  return `<h3>${esc(p.name ?? (p.kind === 'bicicletario' ? 'Bicicletário' : 'Paraciclo'))}</h3>
    ${facts.length ? `<p style="margin:0;color:var(--muted)">${esc(facts.join(' · '))}</p>` : ''}
    <p style="margin:6px 0 0"><span class="dot" style="background:${PARKING_COLORS[p.access]};vertical-align:-1px"></span> <b>${ACCESS[p.access].label}</b><br>${esc(ACCESS[p.access].detail)}${p.biometric ? ' Entrada com biometria.' : ''}</p>
    ${s.detail ? `<p style="margin:6px 0 0">${s.open === false ? '<span class="dot closed" style="vertical-align:-1px"></span> ' : ''}${esc(s.detail)}</p>` : ''}
    <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">Fonte: ${source}</p>`;
}

const parkingMarkers = []; // [{ marker, props }]
let parkingLoading = null;

function loadParking() {
  if (!map.hasLayer(parkingGroup) || map.getZoom() < PARKING_MIN_ZOOM) return;
  parkingLoading ??= getJson('data/bike-parking.geojson')
    .then((geo) => {
      for (const { properties: props, geometry } of geo.features) {
        const [lon, lat] = geometry.coordinates;
        const marker = L.marker([lat, lon], { pane: 'parking', keyboard: false, icon: parkingIcon(props.kind, 'livre') })
          .bindTooltip(esc(props.name ?? (props.kind === 'bicicletario' ? 'Bicicletário' : 'Paraciclo')), { direction: 'top', offset: [0, -10] })
          .bindPopup(() => parkingPopup(props));
        parkingMarkers.push({ marker, props, layer: props.kind === 'bicicletario' ? bicicletarioLayer : paracicloLayer });
      }
      renderParking();
      showParkingInView();
    })
    .catch((err) => console.warn('bike parking unavailable', err));
}
map.on('zoomend overlayadd', loadParking);

// Like bus stops, only the parking spots in view are on the map.
function showParkingInView() {
  if (!parkingMarkers.length || map.getZoom() < PARKING_MIN_ZOOM) return;
  const view = map.getBounds().pad(0.25);
  for (const { marker, layer } of parkingMarkers) {
    const inView = view.contains(marker.getLatLng());
    if (inView && !layer.hasLayer(marker)) layer.addLayer(marker);
    else if (!inView && layer.hasLayer(marker)) layer.removeLayer(marker);
  }
}
map.on('moveend', showParkingInView);

/** Recolours the parking markers that opened or closed since the last call. */
function renderParking() {
  const now = new Date();
  for (const { marker, props } of parkingMarkers) {
    const icon = parkingIcon(props.kind, parkingStatus(props, now).colorKey);
    if (marker.options.icon !== icon) marker.setIcon(icon);
  }
}

// ---------------------------------------------------------------- clock & panel

function renderClock() {
  const p = spParts();
  const date = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  const holiday = holidayName(p.iso);
  $('#clock').textContent = holiday ? `${date} · ${holiday}` : date;
}

initSheets();
initUpdates();
const locate = initLocate(map);

function applyFocus() {
  focus = busFocus ?? planFocus;
  for (const line of lines) for (const t of line.tracks) t.setStyle({ opacity: railOpacity(line) });
  for (const line of busLineByCode.values()) for (const r of line.routes) r.setStyle({ opacity: busOpacity(line.code) });
  for (const bus of state.buses) busMarkers.get(busId(bus))?.setOpacity(busOpacity(bus.line));
}

/** Planner: fade what a planned trip doesn't use (null = nothing planned). */
function focusLines(used) {
  planFocus = used;
  applyFocus();
}

/** Highlights the route of `bus` (its direction) and fades the other bus lines; null undoes it. */
function highlightBus(bus) {
  const line = bus && busLineByCode.get(bus.line);
  highlighted = line ? { code: line.code, sentido: line.routes.some((r) => r.sentido === bus.sentido) ? bus.sentido : null } : null;
  busFocus = line ? { buses: new Set([line.code]), rails: planFocus?.rails ?? null } : null;
  applyFocus();
  for (const r of busRouteLayer.getLayers()) {
    r.setStyle({ weight: weightOf(r) });
    if (isHighlighted(r)) r.bringToFront();
  }
  // A line it doesn't usually run may not be drawn yet: highlight it once it is.
  if (line?.unusual && !line.routes.length) {
    loadUnusualRoute(line).then(() => { if (highlighted?.code === line.code && line.routes.length) highlightBus(bus); });
  }
}

// Bus arrows point the way the bus goes on screen, so they turn when the map does.
map.on('rotate', () => {
  const bearing = map.getBearing();
  for (const marker of busMarkers.values()) {
    const svg = marker.getElement()?.querySelector('.bus-icon');
    if (svg?.dataset.heading) svg.style.transform = iconTransform(Number(svg.dataset.heading) - bearing);
  }
});

initPlanner({
  map,
  rotatingPane,
  focusLines,
  locate,
  sheetInsets,
  railLines: lineByRef,
  getBuses: () => (state.busesLoaded && !state.busError ? state.buses : null),
});

renderClock();
renderRail();
renderBuses();
loadParking();
refreshLive();
refreshBuses();
railGeoPromise.then(addRailGeometry);
busGeoPromise.then((geo) => {
  addBusRoutes(geo);
  renderBuses();
});
emtuGeoPromise.then((geo) => {
  addBusRoutes(geo);
  renderBuses();
});
setInterval(() => { renderClock(); renderRail(); renderParking(); }, CLOCK_REFRESH_MS);
setInterval(refreshLive, RAIL_REFRESH_MS);
setInterval(refreshBuses, BUS_REFRESH_MS);
