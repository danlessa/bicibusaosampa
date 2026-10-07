// Bici Busão Sampa — live map of the buses and rail lines that carry bicycles in Greater São Paulo.

import { headingOfMove, headingOnRoute, iconTransform } from './heading.js';
import { offsetPolylineClass } from './offset.js';
import { ACCESS, parkingStatus } from './parking.js';
import { railStatus as lineStatus } from './rail.js';
import { bikeStatus, describeTime } from './schedule.js';
import { holidayName, spParts } from './time.js';

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
const STATUS_LABELS = { ok: 'Bici liberada', wait: 'Fora do horário da bici', closed: 'Fechada' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- map

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([-23.55, -46.63], 11);
L.control.zoom({ position: 'topright' }).addTo(map);

// Standard OSM tiles, desaturated in style.css so the line colours stand out.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

map.createPane('tracks').style.zIndex = 405;
// Wider click tolerance so the thin rails are easy to tap.
const trackRenderer = L.canvas({ pane: 'tracks', tolerance: 6 });
map.createPane('busRoutes').style.zIndex = 410;
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

L.control.layers(null, Object.fromEntries(TOGGLES.map(([, label, layer]) => [label, layer])), {
  position: 'topright',
  collapsed: matchMedia('(max-width: 640px)').matches,
}).addTo(map);

function rememberLayers() {
  const off = TOGGLES.filter(([, , layer]) => !map.hasLayer(layer)).map(([key]) => key);
  try { localStorage.setItem('hiddenLayers', JSON.stringify(off)); } catch {}
}
map.on('overlayadd overlayremove', rememberLayers);
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
const [railConfig, busConfig] = await Promise.all([
  getJson('data/rail-lines.json'),
  getJson('data/bike-buses.json'),
]);

const state = {
  live: {}, // ref -> { code, status, description }
  buses: [],
  busError: null,
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
      iconSize: [16 * n + 2 * (n - 1), 16],
      iconAnchor: [(16 * n + 2 * (n - 1)) / 2, 8],
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
      const track = L.polyline(latlngs, { renderer: trackRenderer, weight: 2, opacity: 1 });
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
    ${s.note ? `<p style="margin:6px 0 0;color:var(--muted)">${esc(s.note)}</p>` : ''}
    <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">${esc(railConfig.bikeRules.summary)}</p>`;
}

function renderRail() {
  const now = new Date();
  const items = lines.map((line) => {
    const s = railStatus(line, now);
    for (const t of line.tracks) t.setStyle({ color: STATUS_COLORS[s.status] });
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
const busLineByCode = new Map(busConfig.lines.map((l) => [l.code, newLine(l)]));

// Bike status of buses right now ('ok' or 'wait'), refreshed by renderBuses().
let busNow = 'ok';
const lineColor = (line) => busColor(busNow, line?.unusual);

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
map.on('zoomend', () => {
  const weight = routeWeight(map.getZoom());
  busRouteLayer.eachLayer((r) => r.setStyle({ weight }));
});

function addRoute(line, sentido, coordinates, lane, headsign) {
  const latlngs = coordinates.map(([lon, lat]) => [lat, lon]);
  if (latlngs.length < 2) return;
  line.shapes[sentido] = latlngs;
  const route = new OffsetPolyline(latlngs, {
    renderer: busRouteRenderer,
    weight: routeWeight(map.getZoom()),
    opacity: 1,
    offset: (zoom) => laneOffset(lane, zoom),
    color: lineColor(line),
  }).bindTooltip(`${esc(line.code)}${headsign ? ` → ${esc(headsign)}` : ''}`, { sticky: true });
  busRouteLayer.addLayer(route);
  line.routes.push(route);
  line.bounds = line.bounds ? line.bounds.extend(route.getBounds()) : route.getBounds();
}

function addBusRoutes(busGeo) {
  for (const f of busGeo.features) {
    const line = busLineByCode.get(f.properties.code);
    if (line) addRoute(line, f.properties.sentido, f.geometry.coordinates, f.properties.lane ?? 0, f.properties.headsign);
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
  iconSize: [14, 16],
  iconAnchor: [7, 8],
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
  expectedStopsLoading ??= getJson('data/bus-stops.geojson')
    .then((geo) => addStops(geo.features.map((f) => ({ ...f.properties, coordinates: f.geometry.coordinates }))))
    .catch((err) => console.warn('bus stops unavailable', err));
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
  const rows = [...lines].sort().map((code) => {
    const n = state.buses.filter((b) => b.line === code).length;
    return `<p style="margin:4px 0">${busBadge(code)} ${esc(busLineByCode.get(code)?.name ?? '')}${n ? ` · ${n} com suporte agora` : ''}</p>`;
  });
  return `<h3>Ponto: ${esc(name)}</h3>${rows.join('')}
    <p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}</p>`;
}

function busBadge(code) {
  return `<span class="badge" style="background:${lineColor(busLineByCode.get(code))}">${esc(code)}</span>`;
}

// A box in the bus colour with an arrow pointing right; turned by iconTransform()
// to point the way the bus is going.
const busSvg = (body, ink) => `<svg class="bus-icon" viewBox="0 0 26 14" width="26" height="14" aria-hidden="true">
  <rect x="1" y="1" width="24" height="12" rx="3" fill="${body}" stroke="${ink}" stroke-width="2"/>
  <path d="M6 7h11M13.5 3.6 17.5 7l-4 3.4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const busIcons = new Map();
function busIcon(status, unusual) {
  const key = `${status}|${unusual}`;
  if (!busIcons.has(key)) {
    busIcons.set(key, L.divIcon({
      className: 'bus-marker',
      html: busSvg(busColor(status, unusual), '#1c1917'),
      iconSize: [26, 14],
      iconAnchor: [13, 7],
      popupAnchor: [0, -7],
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
  const prev = lastPosition.get(bus.prefix);
  angle ??= prev ? headingOfMove(prev, here) : null;
  angle ??= lastHeading.get(bus.prefix) ?? null;
  lastPosition.set(bus.prefix, here);
  if (angle != null) lastHeading.set(bus.prefix, angle);
  return angle;
}

const busMarkers = new Map(); // prefix -> marker

function busPopup(bus, s) {
  const line = busLineByCode.get(bus.line);
  const seen = bus.at ? new Date(bus.at) : null;
  return `<h3>Ônibus ${esc(bus.prefix)}</h3>
    <p style="margin:0">${busBadge(bus.line)} → ${esc(bus.to)}</p>
    ${line?.name ? `<p style="margin:2px 0 0;color:var(--muted)">${esc(line.name)}</p>` : ''}
    ${bus.expected ? '' : `<p style="margin:6px 0 0">⚠️ <b>Fora da rota habitual</b>: este ônibus com suporte para bici está rodando numa linha que normalmente não usa superarticulados.</p>`}
    <p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> <b>${STATUS_LABELS[s.status]}</b><br>${esc(s.detail)}</p>
    ${bus.accessible ? '<p style="margin:6px 0 0">♿ Acessível</p>' : ''}
    ${seen ? `<p style="margin:0;color:var(--muted)">Posição das ${describeTime(seen)}</p>` : ''}
    ${line?.note ? `<p style="margin:6px 0 0">⚠️ ${esc(line.note)}</p>` : ''}
    <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">${esc(busConfig.rules.summary)}</p>`;
}

function lineItem(code, n) {
  const line = busLineByCode.get(code);
  const count = !state.busesLoaded ? 'carregando posições…'
    : n ? `${n} ônibus com suporte agora` : 'nenhum ônibus com suporte agora';
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
  const expected = [...busLineByCode.values()].filter((l) => !l.unusual).map((l) => l.code).sort(byCount);
  const unusual = [...busLineByCode.values()].filter((l) => l.unusual).map((l) => l.code).sort(byCount);
  const active = expected.filter((c) => counts.has(c)).length;

  $('#bus-count').textContent = state.busesLoaded && !state.busError ? `· ${state.buses.length} ao vivo` : '';
  $('#bus-status').innerHTML = `<span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}. `
    + esc(busConfig.rules.summary)
    + (state.busError ? `<br><b>Posições ao vivo indisponíveis</b> (${esc(state.busError)}).` : '');
  $('#bus-unusual').hidden = !unusual.length;
  const offRoute = unusual.reduce((n, c) => n + (counts.get(c) ?? 0), 0);
  $('#bus-unusual-summary').textContent = `Fora da rota habitual (${offRoute} ônibus em ${unusual.length} ${unusual.length === 1 ? 'linha' : 'linhas'})`;
  $('#bus-unusual-list').innerHTML = unusual.map((c) => lineItem(c, counts.get(c))).join('');
  $('#bus-lines-summary').textContent = `Linhas habituais (${active} de ${expected.length} com ônibus agora)`;
  $('#bus-list').innerHTML = expected.map((c) => lineItem(c, counts.get(c))).join('');
}

function renderBusMarkers(s) {
  const seen = new Set();
  for (const bus of state.buses) {
    seen.add(bus.prefix);
    const icon = busIcon(s.status, !bus.expected);
    let marker = busMarkers.get(bus.prefix);
    if (!marker) {
      marker = L.marker([bus.lat, bus.lon], { keyboard: false, icon })
        .bindPopup('')
        .addTo(busLayer);
      busMarkers.set(bus.prefix, marker);
    }
    marker.setLatLng([bus.lat, bus.lon]).setPopupContent(busPopup(bus, s));
    if (marker.options.icon !== icon) marker.setIcon(icon);
    const svg = marker.getElement()?.querySelector('.bus-icon');
    if (svg) svg.style.transform = iconTransform(busHeading(bus));
  }
  for (const [prefix, marker] of busMarkers) {
    if (!seen.has(prefix)) {
      marker.remove();
      busMarkers.delete(prefix);
    }
  }
}

$('#bus-section').addEventListener('click', async (e) => {
  const code = e.target.closest('li[data-code]')?.dataset.code;
  const line = busLineByCode.get(code);
  if (!line) return;
  if (line.unusual) await loadUnusualRoute(line);
  let bounds = line.bounds;
  const markers = state.buses.filter((b) => b.line === code).map((b) => busMarkers.get(b.prefix)).filter(Boolean);
  for (const m of markers) bounds = bounds ? bounds.extend(m.getLatLng()) : L.latLngBounds([m.getLatLng()]);
  if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  for (const r of line.routes) r.setStyle({ weight: routeWeight(map.getZoom()) + 3 });
  setTimeout(() => line.routes.forEach((r) => r.setStyle({ weight: routeWeight(map.getZoom()) })), 2500);
});

async function refreshBuses() {
  try {
    const data = await getJson('api/buses');
    if (data.error) throw new Error(data.error);
    state.buses = data.vehicles ?? [];
    state.busError = null;
  } catch (err) {
    state.busError = err.message;
  }
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
const parkingSvg = (kind, fill) => {
  const { size, outline, stand } = PARKING_SHAPES[kind];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <g fill="${fill}" stroke="#1c1917" stroke-width="1.6">${outline}</g>
    <path d="M8.6 16.4V11.4a3.4 3.4 0 0 1 6.8 0v5M6.6 16.6h10.8" transform="translate(0 ${stand})" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
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
      html: parkingSvg(kind, PARKING_COLORS[colorKey]),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
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
    <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">Leve seu cadeado. Fonte: ${source}</p>`;
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
          .bindPopup(() => parkingPopup(props))
          .addTo(props.kind === 'bicicletario' ? bicicletarioLayer : paracicloLayer);
        parkingMarkers.push({ marker, props });
      }
      renderParking();
    })
    .catch((err) => console.warn('bike parking unavailable', err));
}
map.on('zoomend overlayadd', loadParking);

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
    timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  const holiday = holidayName(p.iso);
  $('#clock').textContent = `${date} (horário de SP)${holiday ? ` · Feriado: ${holiday}` : ''}`;
}

const panel = $('#panel');
$('#panel-toggle').addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  $('#panel-toggle').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('panelCollapsed', collapsed ? '1' : ''); } catch {}
});
let startCollapsed = matchMedia('(max-width: 640px)').matches;
try {
  const saved = localStorage.getItem('panelCollapsed');
  if (saved !== null) startCollapsed = saved === '1';
} catch {}
if (startCollapsed) $('#panel-toggle').click();

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
setInterval(() => { renderClock(); renderRail(); renderParking(); }, CLOCK_REFRESH_MS);
setInterval(refreshLive, RAIL_REFRESH_MS);
setInterval(refreshBuses, BUS_REFRESH_MS);
