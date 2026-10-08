// Trip planner panel: origin and destination on the map, mode, pace and departure time,
// and the journeys from planner-worker.js, listed in the panel and drawn on the map.

import { ACCESS } from './parking.js';
import { balance, DEFAULT_TIME_WEIGHT, flatSpeed, POWER_LEVELS, TIME_WEIGHTS } from './raptor.js';

const PACES = [
  ['suave', 'Suave'],
  ['endorfinado', 'Endorfinado'],
  ['intenso', 'Intenso'],
  ['competicao', 'Competição'],
];
const COLORS = { walk: '#57534e', bike: '#dc2626', busBike: '#16a34a', bus: '#1c1917' };
const MODE_ICON = { walk: '🚶', bike: '🚲', park: '🅿️', station: '🚉', bus: '🚌', metro: '🚇', train: '🚆' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hhmm = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const minutes = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const kcal = (k) => `${Math.round(k)} kcal`;
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 10) * 10} m`);

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * map: the Leaflet map; railLines: Map ref → rail-lines.json line;
 * getBuses(): live /api/buses vehicles, or null when they couldn't be loaded.
 */
export function initPlanner({ map, railLines, getBuses }) {
  const details = $('#plan-details');
  const status = $('#plan-status');
  const results = $('#plan-results');
  const pointButtons = { from: $('#plan-from'), to: $('#plan-to') };
  const pointLabels = { from: 'Origem', to: 'Destino' };

  const power = $('#plan-power');
  power.innerHTML = PACES.map(([key, name]) =>
    `<option value="${key}">${name}: ${POWER_LEVELS[key]} W, ~${Math.round(flatSpeed(POWER_LEVELS[key]) * 3.6)} km/h no plano</option>`).join('');
  power.value = recall('planPower') ?? 'endorfinado';
  const savedProfile = recall('planProfile');
  if (savedProfile) for (const r of document.querySelectorAll('input[name="plan-profile"]')) r.checked = r.value === savedProfile;
  const savedOptimize = recall('planOptimize');
  if (savedOptimize) for (const r of document.querySelectorAll('input[name="plan-optimize"]')) r.checked = r.value === savedOptimize;

  // The planned trip sits above everything on the map (Leaflet's markers are at 600),
  // below tooltips (650) and popups (700). SVG, not canvas: a canvas this high would
  // swallow clicks meant for the buses and stations underneath.
  map.createPane('plan').style.zIndex = 640;
  const iconPane = map.createPane('planIcons');
  iconPane.style.zIndex = 642;
  iconPane.style.pointerEvents = 'none';
  map.createPane('planPins').style.zIndex = 645;
  const renderer = L.svg({ pane: 'plan' });
  const routeLayer = L.layerGroup().addTo(map);
  const iconLayer = L.layerGroup().addTo(map);
  let iconLegs = []; // { path, glyph, color } of the selected journey
  const points = { from: null, to: null };
  const markers = { from: null, to: null };
  let picking = null;
  let journeys = [];
  let candidates = null; // all of "Balanceado"'s options, re-ranked when its weight changes
  let selected = 0;
  const SHOWN = 6;

  // ---------------------------------------------------------------- worker

  let worker = null;
  let lastId = 0;
  const pending = new Map();
  function ask(message) {
    if (!worker) {
      worker = new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        pending.get(data.id)?.(data);
        pending.delete(data.id);
      };
      worker.onerror = (e) => {
        for (const resolve of pending.values()) resolve({ kind: 'error', message: e.message || 'falha no planejador' });
        pending.clear();
        worker = null;
      };
    }
    const id = ++lastId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ ...message, id });
    });
  }

  let loaded = false;
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) {
      ask({ kind: 'load' }).then((r) => { loaded = r.kind === 'loaded'; });
    }
  });

  // ---------------------------------------------------------------- points

  const pinIcon = (letter) => L.divIcon({
    className: 'plan-pin',
    html: `<span class="pin ${letter === 'A' ? 'a' : 'b'}">${letter}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  function setPoint(which, latlng) {
    points[which] = { lat: latlng.lat, lon: latlng.lng };
    if (!markers[which]) {
      markers[which] = L.marker(latlng, { pane: 'planPins', icon: pinIcon(which === 'from' ? 'A' : 'B'), draggable: true, keyboard: false })
        .on('dragend', (e) => setPoint(which, e.target.getLatLng()))
        .addTo(map);
    } else {
      markers[which].setLatLng(latlng);
    }
    pointButtons[which].querySelector('.label').textContent = `${pointLabels[which]}: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    pointButtons[which].classList.add('set');
    stopPicking();
    update();
  }

  function startPicking(which) {
    picking = which;
    map.getContainer().classList.add('picking');
    for (const [k, b] of Object.entries(pointButtons)) b.classList.toggle('active', k === which);
    status.textContent = `Toque no mapa para marcar ${which === 'from' ? 'a origem' : 'o destino'}.`;
  }

  function stopPicking() {
    picking = null;
    map.getContainer().classList.remove('picking');
    for (const b of Object.values(pointButtons)) b.classList.remove('active');
  }

  for (const [which, button] of Object.entries(pointButtons)) {
    button.addEventListener('click', () => (picking === which ? stopPicking() : startPicking(which)));
  }
  // Caught before it reaches the map: almost every spot has a bus route or a bus under
  // it, and those would open their popup instead. A drag still pans the map.
  map.getContainer().addEventListener('click', (e) => {
    if (!picking || map.dragging?.moved() || e.target.closest('.leaflet-control, .leaflet-popup')) return;
    e.stopPropagation();
    const which = picking;
    setPoint(which, map.mouseEventToLatLng(e));
    // After the origin, go straight to the destination if it's still missing.
    if (which === 'from' && !points.to) startPicking('to');
  }, true);

  // Long press (or right click) anywhere: start or end the trip here.
  map.on('contextmenu', (e) => {
    const box = document.createElement('div');
    box.className = 'plan-menu';
    box.innerHTML = '<button type="button" data-p="from">Sair daqui</button><button type="button" data-p="to">Ir para cá</button>';
    const popup = L.popup({ closeButton: false }).setLatLng(e.latlng).setContent(box).openOn(map);
    box.addEventListener('click', (ev) => {
      const which = ev.target.closest('button')?.dataset.p;
      if (!which) return;
      map.closePopup(popup);
      openPanel();
      setPoint(which, e.latlng);
    });
  });

  $('#plan-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { status.textContent = 'Este navegador não informa a localização.'; return; }
    status.textContent = 'Buscando sua localização…';
    navigator.geolocation.getCurrentPosition(
      (pos) => setPoint('from', L.latLng(pos.coords.latitude, pos.coords.longitude)),
      () => { status.textContent = 'Não foi possível obter sua localização.'; },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });

  $('#plan-swap').addEventListener('click', () => {
    const { from, to } = points;
    if (!from || !to) return;
    setPoint('from', L.latLng(to.lat, to.lon));
    setPoint('to', L.latLng(from.lat, from.lon));
  });

  $('#plan-clear').addEventListener('click', () => {
    for (const which of ['from', 'to']) {
      markers[which]?.remove();
      markers[which] = points[which] = null;
      pointButtons[which].classList.remove('set');
      pointButtons[which].querySelector('.label').textContent = `${pointLabels[which]}: toque aqui e depois no mapa`;
    }
    stopPicking();
    journeys = [];
    routeLayer.clearLayers();
    iconLegs = [];
    iconLayer.clearLayers();
    results.innerHTML = '';
    status.textContent = '';
  });

  function openPanel() {
    details.open = true;
    if ($('#panel').classList.contains('collapsed')) $('#panel-toggle').click();
  }

  // ---------------------------------------------------------------- options

  const profile = () => document.querySelector('input[name="plan-profile"]:checked').value;
  const optimize = () => document.querySelector('input[name="plan-optimize"]:checked').value;
  const weight = $('#plan-weight');
  const weightLabel = $('#plan-weight-label');
  const WEIGHT_TEXT = TIME_WEIGHTS.map((k) => `1 min vale ${k} kcal`);
  const savedWeight = TIME_WEIGHTS.indexOf(Number(recall('planTimeWeightK')));
  weight.value = String(savedWeight >= 0 ? savedWeight : TIME_WEIGHTS.indexOf(DEFAULT_TIME_WEIGHT));
  const timeWeight = () => TIME_WEIGHTS[Number(weight.value)];
  function syncWeight() {
    $('#plan-weight-field').hidden = optimize() !== 'balanced';
    weightLabel.textContent = WEIGHT_TEXT[Number(weight.value)];
  }
  syncWeight();
  for (const r of document.querySelectorAll('input[name="plan-optimize"]')) {
    r.addEventListener('change', () => { remember('planOptimize', optimize()); syncWeight(); update(); });
  }
  // Only re-ranks: the candidates don't depend on the weight.
  weight.addEventListener('input', () => {
    remember('planTimeWeightK', String(timeWeight()));
    syncWeight();
    if (!candidates) return;
    journeys = balance(candidates, timeWeight()).slice(0, SHOWN);
    selected = 0;
    render();
  });
  const at = $('#plan-at');
  const arterials = $('#plan-arterials');
  arterials.checked = recall('planAvoidArterials') !== '0';
  arterials.addEventListener('change', () => { remember('planAvoidArterials', arterials.checked ? '1' : '0'); update(); });
  function syncPower() {
    $('#plan-power-field').hidden = profile() === 'walk';
    $('#plan-arterials-field').hidden = profile() === 'walk';
  }
  syncPower();
  for (const r of document.querySelectorAll('input[name="plan-profile"]')) {
    r.addEventListener('change', () => { remember('planProfile', profile()); syncPower(); update(); });
  }
  power.addEventListener('change', () => { remember('planPower', power.value); update(); });
  at.addEventListener('change', update);
  $('#plan-now').addEventListener('click', () => { at.value = ''; update(); });

  // ---------------------------------------------------------------- search

  let searchId = 0;
  async function update() {
    if (!points.from || !points.to) {
      if (!picking) status.textContent = 'Marque a origem e o destino.';
      return;
    }
    const id = ++searchId;
    // The departure field is São Paulo time, which is UTC-3 all year.
    const later = at.value ? new Date(`${at.value}-03:00`) : null;
    const vehicles = later ? null : getBuses();
    const mode = optimize();
    status.textContent = loaded ? 'Calculando…' : 'Baixando a rede de transporte (só na primeira vez)…';
    const reply = await ask({
      kind: 'plan', from: points.from, to: points.to, profile: profile(), optimize: mode, timeWeight: timeWeight(), avoidArterials: arterials.checked,
      power: POWER_LEVELS[power.value], at: (later ?? new Date()).getTime(), vehicles,
    });
    if (id !== searchId) return;
    if (reply.kind === 'error') {
      status.textContent = `Não deu para calcular: ${reply.message}`;
      return;
    }
    loaded = true;
    candidates = mode === 'balanced' ? reply.journeys : null;
    journeys = reply.journeys.slice(0, SHOWN);
    selected = 0;
    const source = later ? 'ônibus pelos horários das linhas habituais'
      : reply.live ? 'superarticulados ao vivo' : 'sem dados ao vivo: ônibus pelas linhas habituais';
    status.textContent = `${journeys.length} ${journeys.length === 1 ? 'opção' : 'opções'} · ${source}${reply.streets ? '' : ' · sem mapa de ruas: trechos a pé e de bici em linha reta'}`;
    render();
  }

  // ---------------------------------------------------------------- results

  function lineName(leg) {
    if (leg.mode === 'bus') return leg.route;
    return railLines.get(leg.rail)?.name ?? `Linha ${leg.rail}`;
  }

  function legColor(leg) {
    if (leg.kind === 'ride') {
      if (leg.mode !== 'bus') return railLines.get(leg.rail)?.color ?? COLORS.bus;
      return leg.withBike ? COLORS.busBike : COLORS.bus;
    }
    return COLORS[leg.kind] ?? COLORS.walk;
  }

  function rideBadge(leg) {
    const label = leg.mode === 'bus' ? leg.route : leg.rail;
    return `<span class="badge" style="background:${legColor(leg)}">${esc(label)}</span>`;
  }

  function summary(j) {
    return j.legs.map((leg) => {
      if (leg.kind === 'ride') return `${MODE_ICON[leg.mode]}${rideBadge(leg)}`;
      if (leg.kind === 'station') return null; // inside the ride's time in the summary
      if (leg.kind === 'park') return MODE_ICON.park;
      return `${MODE_ICON[leg.kind]}<small>${minutes(leg.arrive - leg.depart)}</small>`;
    }).filter(Boolean).join('<span class="sep">›</span>');
  }

  function legDetail(leg) {
    const span = `${hhmm(leg.depart)}–${hhmm(leg.arrive)}`;
    if (leg.kind === 'station') {
      const climb = leg.up ? `sobe ${leg.up} m` : leg.down ? `desce ${leg.down} m` : '';
      const how = leg.withBike ? 'com a bici, por escada fixa ou elevador' : '';
      return `<li><span class="leg-icon">${MODE_ICON.station}</span><div><b>${leg.dir === 'in' ? 'Entrar na' : 'Sair da'} estação ${esc(leg.at.name)}</b>
        <span class="detail">${span} · ${minutes(leg.arrive - leg.depart)}${climb ? ` · ${climb}` : ''} · ${kcal(leg.kcal)}${how ? ` · ${how}` : ''}</span></div></li>`;
    }
    if (leg.interchange) {
      return `<li><span class="leg-icon">${MODE_ICON.walk}</span><div><b>Baldeação: ${esc(leg.from.name)} → ${esc(leg.to.name)}</b>
        <span class="detail">${span} · ${minutes(leg.arrive - leg.depart)} a pé${leg.withBike ? ', empurrando a bici' : ''} · ${kcal(leg.kcal)}</span></div></li>`;
    }
    if (leg.kind === 'walk' || leg.kind === 'bike') {
      const verb = leg.kind === 'bike' ? 'De bici' : leg.withBike ? 'A pé, empurrando a bici,' : 'A pé';
      return `<li><span class="leg-icon">${MODE_ICON[leg.kind]}</span><div><b>${verb} até ${esc(leg.to.name)}</b>
        <span class="detail">${span} · ${minutes(leg.arrive - leg.depart)} · ${km(leg.meters)} · ${kcal(leg.kcal)}</span></div></li>`;
    }
    if (leg.kind === 'park') {
      return `<li><span class="leg-icon">${MODE_ICON.park}</span><div><b>Deixe a bici: ${esc(leg.at.name)}</b>
        <span class="detail">${esc(ACCESS[leg.at.access]?.label ?? '')}. ${esc(ACCESS[leg.at.access]?.detail ?? '')}</span></div></li>`;
    }
    const notes = [];
    if (leg.withBike) notes.push(leg.mode === 'bus' ? 'Com a bici: embarque pela porta traseira' : 'Com a bici no último carro');
    if (leg.live) notes.push(`Ônibus ${esc(leg.live)}, posição ao vivo`);
    else if (leg.estimated) notes.push('Horário estimado: linha habitual de superarticulados, sem posição ao vivo');
    return `<li><span class="leg-icon">${MODE_ICON[leg.mode]}</span><div><b>${rideBadge(leg)} ${esc(lineName(leg))}</b>
      <span class="detail">sentido ${esc(leg.headsign.trim())}</span>
      <span class="detail">${hhmm(leg.depart)} ${esc(leg.from.name)} → ${hhmm(leg.arrive)} ${esc(leg.to.name)} · ${leg.stops} ${leg.stops === 1 ? 'parada' : 'paradas'}</span>
      ${notes.map((n) => `<span class="detail note-${leg.live ? 'live' : 'plain'}">${n}</span>`).join('')}</div></li>`;
  }

  function render() {
    results.innerHTML = journeys.map((j, i) => `
      <li class="${i === selected ? 'selected' : ''}" data-i="${i}">
        <button type="button" class="plan-journey" aria-expanded="${i === selected}">
          <span class="when">${hhmm(j.depart)} → ${hhmm(j.arrive)} <b>${minutes(j.arrive - j.depart)}</b> <span class="kcal">${kcal(j.kcal)}</span></span>
          <span class="legs">${summary(j)}</span>
        </button>
        ${i === selected ? `<ol class="plan-legs">${j.legs.map(legDetail).join('')}</ol>` : ''}
      </li>`).join('');
    draw();
  }

  results.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li || !e.target.closest('.plan-journey')) return;
    selected = Number(li.dataset.i);
    render();
  });

  function draw() {
    routeLayer.clearLayers();
    iconLegs = [];
    const j = journeys[selected];
    if (!j) return;
    const bounds = L.latLngBounds([]);
    for (const leg of j.legs) {
      if (leg.kind === 'station') continue;
      if (leg.kind === 'park') {
        L.marker([leg.at.lat, leg.at.lon], {
          pane: 'planPins',
          icon: L.divIcon({ className: 'plan-park', html: '🅿️', iconSize: [22, 22], iconAnchor: [11, 11] }),
          keyboard: false,
        }).bindTooltip(`Deixe a bici: ${esc(leg.at.name)}`).addTo(routeLayer);
        continue;
      }
      const path = leg.path ?? [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
      const color = legColor(leg);
      // Riding legs are a trail of icons (bike, bus wheel, rail track) over a thin line
      // that keeps the shape on curves; walking stays a dotted line.
      const glyph = leg.kind === 'bike' ? 'bike' : leg.kind === 'ride' ? (leg.mode === 'bus' ? 'wheel' : 'rail') : null;
      if (glyph) {
        const line = L.polyline(path, { renderer, color, weight: 3, opacity: 0.55 }).addTo(routeLayer);
        if (leg.kind === 'ride') line.bindTooltip(`${lineName(leg)} · sentido ${esc(leg.headsign.trim())}`);
        iconLegs.push({ path, glyph, color });
      } else {
        L.polyline(path, { renderer, color: '#ffffff', weight: 7, opacity: 0.8, interactive: false }).addTo(routeLayer);
        L.polyline(path, { renderer, color, weight: 4, dashArray: '1 7', lineCap: 'round' }).addTo(routeLayer);
      }
      for (const p of path) bounds.extend(p);
    }
    if (!bounds.isValid()) return;
    // Keep the route clear of the panel: on the left on wide screens, at the bottom on phones.
    const box = $('#panel').getBoundingClientRect(), size = map.getSize();
    const bottomSheet = box.left < 1 && box.width >= size.x - 1;
    map.fitBounds(bounds, {
      paddingTopLeft: [bottomSheet ? 30 : box.right + 30, 30],
      paddingBottomRight: [60, bottomSheet ? size.y - box.top + 30 : 30],
      maxZoom: 15,
    });
    placeIcons();
  }

  // ---------------------------------------------------------------- icon trail

  const ICON_GAP = 26;  // px between icons along the route
  const ICON_SIZE = 18;
  // White glyphs on a disc in the leg colour (24×24 view box, drawn facing east/up).
  const GLYPHS = {
    bike: '<circle cx="6" cy="15" r="4"/><circle cx="18" cy="15" r="4"/><path d="M6 15l4-7h6l2 7M10 8l3 7M8 5h4M15 6h3"/>',
    wheel: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v6M12 14v6M4 12h6M14 12h6M6.3 6.3l4.3 4.3M13.4 13.4l4.3 4.3M17.7 6.3l-4.3 4.3M10.6 13.4l-4.3 4.3"/>',
    rail: '<path d="M8.5 3v18M15.5 3v18M5.5 6.5h13M5.5 12h13M5.5 17.5h13"/>',
  };

  function trailIcon(glyph, color, angle) {
    // Rails turn with the track; the bike faces where it's going; the wheel doesn't care.
    const turn = glyph === 'rail' ? `rotate(${angle + 90}deg)` : glyph === 'bike' && Math.cos((angle * Math.PI) / 180) < 0 ? 'scaleX(-1)' : '';
    return L.divIcon({
      className: 'plan-trail',
      html: `<span style="background:${color}"><svg viewBox="0 0 24 24" style="transform:${turn}">${GLYPHS[glyph]}</svg></span>`,
      iconSize: [ICON_SIZE, ICON_SIZE],
      iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    });
  }

  // Icons every ICON_GAP px along each leg, only where the map shows them.
  function placeIcons() {
    iconLayer.clearLayers();
    if (!iconLegs.length) return;
    const view = map.getPixelBounds().pad(0.1);
    for (const { path, glyph, color } of iconLegs) {
      const pts = path.map((p) => map.project(p));
      let next = ICON_GAP / 2;
      let walked = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const len = a.distanceTo(b);
        if (!len) continue;
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        while (next <= walked + len) {
          const f = (next - walked) / len;
          const p = L.point(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
          if (view.contains(p)) {
            L.marker(map.unproject(p), { pane: 'planIcons', icon: trailIcon(glyph, color, angle), interactive: false, keyboard: false }).addTo(iconLayer);
          }
          next += ICON_GAP;
        }
        walked += len;
      }
    }
  }
  map.on('zoomend moveend', placeIcons);
}
