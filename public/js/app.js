// Bici Busão Sampa — live map of the buses and rail lines that carry bicycles in Greater São Paulo.

import { hatchRenderer } from './hatch.js';
import { headingOfMove, headingOnRoute, iconTransform } from './heading.js';
import { assignLanes, offsetPolylineClass } from './offset.js';
import { railStatus as lineStatus } from './rail.js';
import { bikeStatus, describeTime } from './schedule.js';
import { holidayName, spParts } from './time.js';

const RAIL_REFRESH_MS = 60_000;
const BUS_REFRESH_MS = 20_000;
const CLOCK_REFRESH_MS = 15_000;

const STATUS_COLORS = { ok: '#16a34a', wait: '#eab308', closed: '#dc2626' };
const ELECTRIC_COLOR = '#facc15';
// Bus routes: yellow (electric) or green, hatched black.
const ROUTE_COLORS = { electric: ELECTRIC_COLOR, other: '#16a34a', hatch: '#111111' };
// Bus icons: body colour = vehicle type, silhouette colour = bike status
// (black when bikes are allowed, red when not). Buses have no "closed" state.
const BUS_BODY = { electric: ELECTRIC_COLOR, other: '#16a34a' };
const BUS_INK = { ok: '#1c1917', wait: '#dc2626' };
const BUS_STATUS = { ok: 'ink', wait: 'closed' }; // dot classes in the panel/popups
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
const busRouteRenderer = hatchRenderer(L, { pane: 'busRoutes' });
map.createPane('busStops').style.zIndex = 415;
map.createPane('stations').style.zIndex = 420;

const trackLayer = L.layerGroup();
const stationLayer = L.layerGroup();
const busRouteLayer = L.layerGroup();
const busStopLayer = L.layerGroup();
const busLayer = L.layerGroup();

// Stations and stops only appear when zoomed in, inside a group the user can toggle.
const stationGroup = L.layerGroup();
const busStopGroup = L.layerGroup();
const ZOOMED_LAYERS = [[stationLayer, stationGroup, 12], [busStopLayer, busStopGroup, 14]];

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
const BUS_SCALE = { 10: 0.4, 11: 0.5, 12: 0.65, 13: 0.85 };
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
const busStopsPromise = getJson('data/bus-stops.geojson').catch(() => ({ features: [] }));
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

// `shapes` maps Olho Vivo "sentido" (1 or 2) to the route as [[lat, lon], ...] in travel order.
const busLines = busConfig.lines.map((l) => ({ ...l, routes: [], shapes: {}, bounds: null }));
const busLineByCode = new Map(busLines.map((l) => [l.code, l]));

const busColor = () => getComputedStyle(document.documentElement).getPropertyValue('--bus').trim() || '#111';

const OffsetPolyline = offsetPolylineClass(L);
// Pixel offset of lane n: routes sit beside the street centre, right of travel direction.
const laneOffset = (lane) => 3.5 + lane * 5.5;

function addBusRoutes(busGeo) {
  const features = busGeo.features.filter((f) => busLineByCode.has(f.properties.code) && f.geometry.coordinates.length >= 2);
  const shapesByCode = {};
  for (const f of features) {
    const latlngs = f.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    busLineByCode.get(f.properties.code).shapes[f.properties.sentido] = latlngs;
    (shapesByCode[f.properties.code] ??= []).push(latlngs);
  }
  const lanes = assignLanes(shapesByCode, (p, route) => headingOnRoute(p, route)?.distance ?? Infinity);

  for (const f of features) {
    const line = busLineByCode.get(f.properties.code);
    const route = new OffsetPolyline(line.shapes[f.properties.sentido], {
      renderer: busRouteRenderer,
      weight: 5,
      opacity: 1,
      offset: laneOffset(lanes[line.code]),
      hatch: { base: line.electric ? ROUTE_COLORS.electric : ROUTE_COLORS.other, stripe: ROUTE_COLORS.hatch },
    }).bindTooltip(`${esc(line.code)} → ${esc(f.properties.headsign)}`, { sticky: true });
    busRouteLayer.addLayer(route);
    line.routes.push(route);
    line.bounds = line.bounds ? line.bounds.extend(route.getBounds()) : route.getBounds();
  }
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

function addBusStops(stopsGeo) {
  for (const f of stopsGeo.features) {
    const [lon, lat] = f.geometry.coordinates;
    L.marker([lat, lon], { pane: 'busStops', icon: busStopIcon, keyboard: false })
      .bindTooltip(esc(f.properties.name), { direction: 'top', offset: [0, -8] })
      .bindPopup(() => {
        const s = bikeStatus({ bikes: busConfig.rules.bikes });
        const lines = f.properties.lines.map((code) => {
          const n = state.buses.filter((b) => b.line === code).length;
          return `<p style="margin:4px 0">${busBadge(code)} ${esc(busLineByCode.get(code)?.name ?? '')}${n ? ` · ${n} ônibus agora` : ''}</p>`;
        });
        return `<h3>Ponto: ${esc(f.properties.name)}</h3>${lines.join('')}
          <p style="margin:6px 0 0"><span class="dot ${BUS_STATUS[s.status]}" style="vertical-align:-1px"></span> ${esc(s.detail)}</p>`;
      })
      .addTo(busStopLayer);
  }
}

function busBadge(code) {
  const electric = busLineByCode.get(code)?.electric;
  const style = electric
    ? `background:${ROUTE_COLORS.electric};color:#111;text-shadow:none`
    : `background:${ROUTE_COLORS.other}`;
  return `<span class="badge" style="${style}">${esc(code)}</span>`;
}

// Side view of an articulated bus, front to the right, with a chevron on each
// carriage showing the direction of travel; turned by iconTransform().
const busSvg = (body, ink) => `<svg class="bus-icon" viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
  <rect x="0.9" y="1.5" width="38.2" height="11" rx="2" fill="${body}" stroke="${ink}" stroke-width="1.8"/>
  <path d="M35 3.2h2.3a1.2 1.2 0 0 1 1.2 1.2v4.3H35z" fill="#e0f2fe"/>
  <rect x="18.1" y="1.5" width="2.3" height="11" fill="${ink}" opacity=".7"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6.5 3.6 10.5 7 6.5 10.4M24 3.6 28 7 24 10.4" stroke="${ink}" stroke-width="3.6"/>
    <path d="M6.5 3.6 10.5 7 6.5 10.4M24 3.6 28 7 24 10.4" stroke="#fff" stroke-width="2"/>
  </g>
  <g fill="${ink}" stroke="#fff" stroke-width=".8">
    <circle cx="6" cy="13" r="2.3"/><circle cx="13.5" cy="13" r="2.3"/><circle cx="25.5" cy="13" r="2.3"/><circle cx="33" cy="13" r="2.3"/>
  </g>
</svg>`;

const busIcons = new Map();
function busIcon(status, electric) {
  const key = `${status}|${electric}`;
  if (!busIcons.has(key)) {
    busIcons.set(key, L.divIcon({
      className: 'bus-marker',
      html: busSvg(electric ? BUS_BODY.electric : BUS_BODY.other, BUS_INK[status]),
      iconSize: [40, 16],
      iconAnchor: [20, 8],
      popupAnchor: [0, -8],
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
  return `<h3>${esc(bus.line)} → ${esc(bus.to)}</h3>
    ${line?.name ? `<p style="margin:0">${esc(line.name)}</p>` : ''}
    <p style="margin:6px 0 0"><span class="dot ${BUS_STATUS[s.status]}" style="vertical-align:-1px"></span> <b>${STATUS_LABELS[s.status]}</b><br>${esc(s.detail)}</p>
    <p style="margin:6px 0 0">Prefixo ${esc(bus.prefix)}${bus.accessible ? ' · ♿ acessível' : ''}</p>
    ${seen ? `<p style="margin:0;color:var(--muted)">Posição das ${describeTime(seen)}</p>` : ''}
    ${line?.note ? `<p style="margin:6px 0 0">⚠️ ${esc(line.note)}</p>` : ''}
    <p style="margin:6px 0 0;font-size:12px;color:var(--muted)">${esc(busConfig.rules.summary)}</p>`;
}

function renderBuses() {
  const s = bikeStatus({ bikes: busConfig.rules.bikes });
  const seen = new Set();
  for (const bus of state.buses) {
    seen.add(bus.prefix);
    const icon = busIcon(s.status, Boolean(busLineByCode.get(bus.line)?.electric));
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

  const counts = new Map();
  for (const bus of state.buses) counts.set(bus.line, (counts.get(bus.line) ?? 0) + 1);
  const extraLines = [...counts.keys()].filter((c) => !busLineByCode.has(c));

  $('#bus-count').textContent = state.busesLoaded && !state.busError ? `· ${state.buses.length} ao vivo` : '';
  $('#bus-status').innerHTML = `<span class="dot ${BUS_STATUS[s.status]}" style="vertical-align:-1px"></span> ${esc(s.detail)}. `
    + esc(busConfig.rules.summary)
    + (state.busError ? `<br><b>Posições ao vivo indisponíveis</b> (${esc(state.busError)}).` : '');
  $('#bus-list').innerHTML = [...busLines.map((l) => l.code), ...extraLines].map((code) => {
    const line = busLineByCode.get(code);
    const n = counts.get(code) ?? 0;
    return `<li data-code="${esc(code)}">
      ${busBadge(code)}
      <span><span class="name">${esc(line?.name ?? 'Veículo com suporte')}</span>
        <span class="detail">${!state.busesLoaded ? 'carregando posições…' : n ? `${n} ônibus agora` : 'nenhum ônibus em circulação agora'}${line?.electric ? ' · ⚡ elétrico' : ''}</span>
        ${line?.note ? `<span class="detail">⚠️ ${esc(line.note)}</span>` : ''}</span>
    </li>`;
  }).join('');
}

$('#bus-list').addEventListener('click', (e) => {
  const code = e.target.closest('li')?.dataset.code;
  const line = busLineByCode.get(code);
  let bounds = line?.bounds;
  const markers = state.buses.filter((b) => b.line === code).map((b) => busMarkers.get(b.prefix)).filter(Boolean);
  for (const m of markers) bounds = bounds ? bounds.extend(m.getLatLng()) : L.latLngBounds([m.getLatLng()]);
  if (bounds) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  const base = line?.routes[0]?.options.weight ?? 3;
  for (const r of line?.routes ?? []) r.setStyle({ weight: base + 2 });
  setTimeout(() => line?.routes.forEach((r) => r.setStyle({ weight: base })), 2500);
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
refreshLive();
refreshBuses();
railGeoPromise.then(addRailGeometry);
busGeoPromise.then((geo) => {
  addBusRoutes(geo);
  renderBuses();
});
busStopsPromise.then(addBusStops);
setInterval(() => { renderClock(); renderRail(); }, CLOCK_REFRESH_MS);
setInterval(refreshLive, RAIL_REFRESH_MS);
setInterval(refreshBuses, BUS_REFRESH_MS);
