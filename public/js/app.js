// Busão com Bici — live map of the buses and rail lines that carry bicycles in Greater São Paulo.

import { railStatus as lineStatus } from './rail.js';
import { bikeStatus, describeTime } from './schedule.js';
import { holidayName, spParts } from './time.js';

const RAIL_REFRESH_MS = 60_000;
const BUS_REFRESH_MS = 20_000;
const CLOCK_REFRESH_MS = 15_000;

const STATUS_COLORS = { ok: '#16a34a', wait: '#eab308', closed: '#dc2626' };
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

map.createPane('busRoutes').style.zIndex = 405;
map.createPane('tracks').style.zIndex = 410;
map.createPane('stations').style.zIndex = 420;

const busRouteLayer = L.layerGroup().addTo(map);
const trackLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup();
const busLayer = L.layerGroup().addTo(map);

map.on('zoomend', () => {
  if (map.getZoom() >= 13) stationLayer.addTo(map);
  else stationLayer.remove();
});

// ---------------------------------------------------------------- data

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const [railConfig, busConfig, railGeo, busGeo] = await Promise.all([
  getJson('data/rail-lines.json'),
  getJson('data/bike-buses.json'),
  getJson('data/rail.geojson').catch(() => ({ features: [] })),
  getJson('data/bus-routes.geojson').catch(() => ({ features: [] })),
]);

const state = {
  live: {}, // ref -> { code, status, description }
  buses: [],
  busError: null,
};

// ---------------------------------------------------------------- rail

function railStatus(line, date = new Date()) {
  return lineStatus(line, railConfig.bikeRules.bikes, state.live[line.ref], date);
}

const lines = railConfig.lines.map((line) => ({ ...line, tracks: [], bounds: null }));
const lineByRef = new Map(lines.map((l) => [l.ref, l]));

for (const f of railGeo.features) {
  if (f.properties.kind === 'track') {
    const line = lineByRef.get(f.properties.ref);
    if (!line) continue;
    const latlngs = f.geometry.coordinates.map((part) => part.map(([lon, lat]) => [lat, lon]));
    const casing = L.polyline(latlngs, { pane: 'tracks', weight: 7, opacity: 0.9, lineCap: 'round' });
    const core = L.polyline(latlngs, { pane: 'tracks', weight: 2.5, color: line.color, opacity: 1, interactive: false });
    casing.on('click', (e) => L.popup().setLatLng(e.latlng).setContent(linePopup(line)).openOn(map));
    trackLayer.addLayer(casing).addLayer(core);
    line.tracks.push(casing);
    line.bounds = casing.getBounds();
  } else if (f.properties.kind === 'station') {
    const [lon, lat] = f.geometry.coordinates;
    const refs = f.properties.refs.filter((r) => lineByRef.has(r));
    L.circleMarker([lat, lon], {
      pane: 'stations', radius: 4, weight: 2, color: '#1c1917', fillColor: '#fff', fillOpacity: 1,
    })
      .bindTooltip(esc(f.properties.name), { direction: 'top', offset: [0, -4] })
      .bindPopup(() => `<h3>${esc(f.properties.name)}</h3>${refs.map((r) => lineRow(lineByRef.get(r))).join('')}`)
      .addTo(stationLayer);
  }
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

const busLines = busConfig.lines.map((l) => ({ ...l, routes: [], bounds: null }));
const busLineByCode = new Map(busLines.map((l) => [l.code, l]));

for (const f of busGeo.features) {
  const line = busLineByCode.get(f.properties.code);
  if (!line || f.geometry.coordinates.length < 2) continue;
  const route = L.polyline(f.geometry.coordinates.map(([lon, lat]) => [lat, lon]), {
    pane: 'busRoutes', weight: 3, opacity: 0.55, color: getComputedStyle(document.documentElement).getPropertyValue('--bus').trim() || '#2563eb',
  }).bindTooltip(`${esc(line.code)} → ${esc(f.properties.headsign)}`, { sticky: true });
  busRouteLayer.addLayer(route);
  line.routes.push(route);
  line.bounds = line.bounds ? line.bounds.extend(route.getBounds()) : route.getBounds();
}

const BUS_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="#fff" aria-hidden="true"><path d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>';
const busIcons = Object.fromEntries(
  ['ok', 'wait'].map((status) => [status, L.divIcon({
    className: '',
    html: `<div class="bus-marker" style="background:${STATUS_COLORS[status]}">${BUS_SVG}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  })]),
);

const busMarkers = new Map(); // prefix -> marker

function busPopup(bus, s) {
  const line = busLineByCode.get(bus.line);
  const seen = bus.at ? new Date(bus.at) : null;
  return `<h3>${esc(bus.line)} → ${esc(bus.to)}</h3>
    ${line?.name ? `<p style="margin:0">${esc(line.name)}</p>` : ''}
    <p style="margin:6px 0 0"><span class="dot ${s.status}" style="vertical-align:-1px"></span> <b>${STATUS_LABELS[s.status]}</b><br>${esc(s.detail)}</p>
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
    let marker = busMarkers.get(bus.prefix);
    if (!marker) {
      marker = L.marker([bus.lat, bus.lon], { keyboard: false, icon: busIcons[s.status] })
        .bindPopup('')
        .addTo(busLayer);
      busMarkers.set(bus.prefix, marker);
    }
    marker.setLatLng([bus.lat, bus.lon]).setPopupContent(busPopup(bus, s));
    if (marker.options.icon !== busIcons[s.status]) marker.setIcon(busIcons[s.status]);
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

  $('#bus-count').textContent = state.busError ? '' : `· ${state.buses.length} ao vivo`;
  $('#bus-status').innerHTML = `<span class="dot ${s.status}" style="vertical-align:-1px"></span> ${esc(s.detail)}. `
    + esc(busConfig.rules.summary)
    + (state.busError ? `<br><b>Posições ao vivo indisponíveis</b> (${esc(state.busError)}).` : '');
  $('#bus-list').innerHTML = [...busLines.map((l) => l.code), ...extraLines].map((code) => {
    const line = busLineByCode.get(code);
    const n = counts.get(code) ?? 0;
    return `<li data-code="${esc(code)}">
      <span class="badge" style="background:var(--bus)">${esc(code)}</span>
      <span><span class="name">${esc(line?.name ?? 'Veículo com suporte')}</span>
        <span class="detail">${n ? `${n} ônibus agora` : 'nenhum ônibus em circulação agora'}</span>
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
  for (const r of line?.routes ?? []) r.setStyle({ opacity: 1, weight: 5 });
  setTimeout(() => line?.routes.forEach((r) => r.setStyle({ opacity: 0.55, weight: 3 })), 2500);
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
setInterval(() => { renderClock(); renderRail(); }, CLOCK_REFRESH_MS);
setInterval(refreshLive, RAIL_REFRESH_MS);
setInterval(refreshBuses, BUS_REFRESH_MS);
