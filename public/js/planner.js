// Trip planner panel: origin and destination on the map, mode, pace and departure time,
// and the journeys from planner-worker.js, listed in the panel and drawn on the map.

import { placeName, searchPlaces } from './geocode.js';
import { ACCESS } from './parking.js';
import { balance, DEFAULT_TIME_WEIGHT, flatSpeed, POWER_LEVELS, TIME_WEIGHTS } from './raptor.js';
import { spParts } from './time.js';

const PACES = [
  ['suave', 'Suave'],
  ['endorfinado', 'Endorfinado'],
  ['intenso', 'Intenso'],
  ['competicao', 'Competição'],
];
const GPS_ICON = '<svg viewBox="0 0 512 512" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M445 4 29 195c-48 23-32 93 19 93h176v176c0 51 70 67 93 19L508 67c16-38-25-79-63-63z"/></svg>';
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
 * map: the Leaflet map; locate: locate.js handle (position()); sheetInsets(): screen
 * covered by the menu sheets; railLines: Map ref → rail-lines.json line;
 * getBuses(): live /api/buses vehicles, or null when they couldn't be loaded.
 */
export function initPlanner({ map, locate, sheetInsets, railLines, getBuses, focusLines }) {
  const details = $('#plan-details');
  const status = $('#plan-status');
  const results = $('#plan-results');
  const stopsList = $('#plan-stops');

  const power = $('#plan-power');
  power.innerHTML = PACES.map(([key, name]) =>
    `<option value="${key}">${name}: ~${Math.round(flatSpeed(POWER_LEVELS[key]) * 3.6)} km/h no plano</option>`).join('');
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

  // The network (~18 MB, cached by the service worker afterwards) is only downloaded
  // once someone starts planning, not merely because the section is open.
  let loaded = false;
  let loading = null;
  function ensureLoaded() {
    loading ??= ask({ kind: 'load' }).then((r) => { loaded = r.kind === 'loaded'; if (!loaded) loading = null; });
    return loading;
  }

  // ---------------------------------------------------------------- points

  // Origin, stops in between, destination: [{ lat, lon, label } | null], at least two.
  // A tap on the map fills the first empty slot; with all filled it becomes the new
  // destination and the previous destination turns into a stop.
  let stops = [null, null];
  let markers = [];
  const ROLE = { from: 'Origem', via: 'Parada', to: 'Destino' };
  const role = (i) => (i === 0 ? 'from' : i === stops.length - 1 ? 'to' : 'via');
  const pinText = (i) => ({ from: 'A', to: 'B' }[role(i)] ?? String(i));

  const pinIcon = (i) => L.divIcon({
    className: 'plan-pin',
    html: `<span class="pin ${role(i)}">${pinText(i)}</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -14],
  });

  let quietUntil = 0; // swallow the ghost map click after a search pick, drag or popup close
  const quiet = (ms) => { quietUntil = Date.now() + ms; };

  function syncMarkers() {
    for (const m of markers) m?.remove();
    markers = stops.map((p, i) => {
      if (!p) return null;
      const marker = L.marker([p.lat, p.lon], { pane: 'planPins', icon: pinIcon(i), draggable: true, keyboard: false, autoPan: true })
        .on('dragend', (e) => { quiet(400); const ll = e.target.getLatLng(); setStop(i, { lat: ll.lat, lon: ll.lng }); })
        .addTo(map);
      const box = document.createElement('div');
      box.className = 'plan-menu';
      box.innerHTML = `<b>${esc(ROLE[role(i)])}</b><button type="button">Remover</button>`;
      box.querySelector('button').addEventListener('click', () => { map.closePopup(); quiet(400); removeStop(i); });
      marker.bindPopup(box, { closeButton: false });
      return marker;
    });
  }

  function renderStops() {
    stopsList.innerHTML = stops.map((p, i) => `
      <li class="plan-stop" data-i="${i}">
        <span class="pin ${role(i)}" aria-hidden="true">${pinText(i)}</span>
        <div class="plan-search">
          <input type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
            aria-label="${ROLE[role(i)]}" placeholder="Buscar ${ROLE[role(i)].toLowerCase()}…" value="${esc(p?.label ?? '')}">
          <ul class="plan-suggest" role="listbox" hidden></ul>
        </div>
        ${i === 0 ? `<button type="button" class="plan-icon-btn plan-gps" aria-label="Sair da minha localização" title="Minha localização">${GPS_ICON}</button>` : ''}
        ${role(i) === 'via' ? '<button type="button" class="plan-icon-btn plan-remove" aria-label="Remover parada" title="Remover parada">✕</button>' : ''}
      </li>`).join('');
  }

  const coords = (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

  function setStop(i, point, { label } = {}) {
    const p = { lat: point.lat, lon: point.lon, label: label ?? point.label ?? null };
    stops[i] = p;
    if (!p.label) {
      p.label = coords(p);
      placeName(p.lat, p.lon).then((name) => {
        if (name && stops[i] === p) { p.label = name; renderStops(); }
      });
    }
    syncMarkers();
    renderStops();
    ensureLoaded();
    update();
  }

  function removeStop(i) {
    if (stops.length > 2) stops.splice(i, 1);
    else stops[i] = null;
    syncMarkers();
    renderStops();
    update();
  }

  function addTap(latlng) {
    const point = { lat: latlng.lat, lon: latlng.lng };
    const empty = stops.indexOf(null);
    if (empty >= 0) return setStop(empty, point);
    stops.push(null);
    setStop(stops.length - 1, point);
  }

  // Taps on the map (not on a bus, station or pin, which keep their popups) add points
  // while the planner is open.
  map.on('popupclose', () => quiet(350));
  map.on('click', (e) => {
    if (!details.open || Date.now() < quietUntil) return;
    addTap(e.latlng);
  });

  stopsList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (e.target.closest('.plan-remove')) return removeStop(i);
    if (e.target.closest('.plan-gps')) {
      status.textContent = 'Localizando…';
      locate.position()
        .then((ll) => setStop(0, { lat: ll.lat, lon: ll.lng }, { label: 'Minha localização' }))
        .catch(() => { status.textContent = 'Sem localização.'; });
    }
  });

  $('#plan-add-stop').addEventListener('click', () => {
    stops.splice(stops.length - 1, 0, null);
    syncMarkers();
    renderStops();
    stopsList.querySelector(`li[data-i="${stops.length - 2}"] input`)?.focus();
  });

  $('#plan-swap').addEventListener('click', () => {
    stops.reverse();
    syncMarkers();
    renderStops();
    update();
  });

  $('#plan-clear').addEventListener('click', () => {
    stops = [null, null];
    syncMarkers();
    renderStops();
    journeys = [];
    candidates = null;
    routeLayer.clearLayers();
    iconLegs = [];
    iconLayer.clearLayers();
    labelLegs = [];
    clearLabels();
    focusLines(null);
    results.innerHTML = '';
    status.textContent = '';
    map.getContainer().classList.remove('route-shown');
  });

  // ---------------------------------------------------------------- place search

  let searchTimer = null;
  let searchAbort = null;
  let found = []; // results shown under the focused input
  let active = -1;

  function suggestions(li) { return li.querySelector('.plan-suggest'); }

  function showResults(li, items, message) {
    const ul = suggestions(li);
    found = items;
    active = -1;
    ul.innerHTML = message
      ? `<li class="plan-suggest-note">${esc(message)}</li>`
      : items.map((r, k) => `<li role="option" data-k="${k}"><b>${esc(r.label)}</b>${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</li>`).join('');
    ul.hidden = !message && !items.length;
  }

  function pick(li, k) {
    const r = found[k];
    if (!r) return;
    quiet(700);
    const i = Number(li.dataset.i);
    suggestions(li).hidden = true;
    setStop(i, { lat: r.lat, lon: r.lon }, { label: r.label });
    if (!journeys.length) map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
  }

  stopsList.addEventListener('focusin', (e) => { if (e.target.matches('input')) ensureLoaded(); });
  stopsList.addEventListener('input', (e) => {
    const input = e.target.closest('input');
    if (!input) return;
    const li = input.closest('li[data-i]');
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) return showResults(li, []);
    searchTimer = setTimeout(async () => {
      searchAbort?.abort();
      searchAbort = new AbortController();
      showResults(li, [], 'Buscando…');
      try {
        const items = await searchPlaces(q, map.getCenter(), searchAbort.signal);
        if (input.value.trim() === q) showResults(li, items, items.length ? null : 'Nada encontrado');
      } catch (err) {
        if (err.name !== 'AbortError') showResults(li, [], 'Busca indisponível');
      }
    }, 350);
  });
  // pointerdown, not click: picking must happen before the input's blur hides the list.
  stopsList.addEventListener('pointerdown', (e) => {
    const opt = e.target.closest('.plan-suggest li[data-k]');
    if (!opt) return;
    e.preventDefault();
    pick(opt.closest('li[data-i]'), Number(opt.dataset.k));
  });
  stopsList.addEventListener('keydown', (e) => {
    const input = e.target.closest('input');
    if (!input) return;
    const li = input.closest('li[data-i]');
    const ul = suggestions(li);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!found.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length;
      ul.querySelectorAll('li[data-k]').forEach((o, k) => o.classList.toggle('active', k === active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (found.length) pick(li, Math.max(0, active));
      else input.blur(); // closes the phone keyboard
    } else if (e.key === 'Escape') {
      ul.hidden = true;
    }
  });
  stopsList.addEventListener('focusout', (e) => {
    const li = e.target.closest?.('li[data-i]');
    if (li) setTimeout(() => { suggestions(li).hidden = true; }, 150);
  });

  renderStops();

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

  /** Epoch ms of midnight (São Paulo) of the day `ms` falls in; journey times count from it. */
  const midnight = (ms) => Date.parse(`${spParts(new Date(ms)).iso}T00:00:00-03:00`);

  async function update() {
    const from = stops[0], to = stops[stops.length - 1];
    if (!from || !to) {
      status.textContent = !from ? 'Toque no mapa ou busque a origem.' : 'Agora o destino.';
      return;
    }
    const id = ++searchId;
    // The departure field is São Paulo time, which is UTC-3 all year.
    const later = at.value ? new Date(`${at.value}-03:00`) : null;
    const vehicles = later ? null : getBuses();
    const mode = optimize();
    const options = { profile: profile(), optimize: mode, timeWeight: timeWeight(), avoidArterials: arterials.checked, power: POWER_LEVELS[power.value], vehicles };
    status.textContent = loaded ? 'Calculando…' : 'Baixando dados do planejador (só na primeira vez)…';

    // With stops in between, each leg leaves when the previous one arrives, and the
    // trip is the best option of every leg, one after the other.
    const points = stops.filter(Boolean);
    let start = (later ?? new Date()).getTime();
    const base = midnight(start);
    let reply = null;
    const parts = [];
    for (let k = 0; k + 1 < points.length; k++) {
      reply = await ask({ kind: 'plan', from: points[k], to: points[k + 1], at: start, ...options });
      if (id !== searchId) return;
      if (reply.kind === 'error') { status.textContent = `Não deu para calcular: ${reply.message}`; return; }
      loaded = true;
      if (!reply.journeys.length) {
        status.textContent = points.length > 2 ? `Sem opção até a parada ${k + 1}.` : 'Nenhuma opção encontrada.';
        journeys = []; render();
        return;
      }
      if (points.length === 2) break;
      const best = mode === 'balanced' ? balance(reply.journeys, timeWeight())[0] : reply.journeys[0];
      const shift = (midnight(start) - base) / 1000; // legs after midnight keep counting from day one
      parts.push(shiftJourney(best, shift));
      start = midnight(start) + best.arrive * 1000;
    }

    if (points.length === 2) {
      candidates = mode === 'balanced' ? reply.journeys : null;
      journeys = reply.journeys.slice(0, SHOWN);
    } else {
      candidates = null;
      journeys = [{
        profile: parts[0].profile,
        depart: parts[0].depart,
        arrive: parts.at(-1).arrive,
        kcal: parts.reduce((n, j) => n + j.kcal, 0),
        rides: parts.reduce((n, j) => n + j.rides, 0),
        legs: parts.flatMap((j) => j.legs),
      }];
    }
    selected = 0;
    const live = later || profile() === 'cycle' ? '' : reply.live ? ' · ônibus ao vivo' : '';
    status.textContent = points.length > 2
      ? `Com ${points.length - 2} ${points.length === 3 ? 'parada' : 'paradas'}${live}`
      : `${journeys.length} ${journeys.length === 1 ? 'opção' : 'opções'}${live}`;
    render();
  }

  function shiftJourney(j, s) {
    if (!s) return j;
    const legs = j.legs.map((leg) => ({ ...leg, depart: leg.depart + s, arrive: leg.arrive + s }));
    return { ...j, depart: j.depart + s, arrive: j.arrive + s, legs };
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
      const how = '';
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
        <span class="detail">${esc(ACCESS[leg.at.access]?.label ?? '')}</span></div></li>`;
    }
    const notes = [];
    if (leg.withBike) notes.push(leg.mode === 'bus' ? 'Com a bici: porta traseira' : 'Com a bici: último carro');
    if (leg.live) notes.push(`Ônibus ${esc(leg.live)} ao vivo`);
    else if (leg.estimated) notes.push('Horário estimado');
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
    // With a route on the map, everything else fades so the route stands out, except
    // the bus and rail lines the trip rides on.
    map.getContainer().classList.toggle('route-shown', !!j);
    labelLegs = [];
    focusLines(j ? {
      buses: new Set(j.legs.filter((l) => l.kind === 'ride' && l.mode === 'bus').map((l) => l.route)),
      rails: new Set(j.legs.filter((l) => l.kind === 'ride' && l.mode !== 'bus').map((l) => String(l.rail))),
    } : null);
    clearLabels();
    if (!j) return;
    const bounds = L.latLngBounds([]);
    // With two or more rides of a kind (bus, rail), their icons carry 1, 2, … in order.
    const glyphOf = (leg) => (leg.kind === 'bike' ? 'bike' : leg.kind === 'ride' ? (leg.mode === 'bus' ? 'wheel' : 'rail') : null);
    const rideCount = {};
    for (const leg of j.legs) if (leg.kind === 'ride') rideCount[glyphOf(leg)] = (rideCount[glyphOf(leg)] ?? 0) + 1;
    const rideSeen = {};
    let prev = null; // previous leg drawn, for the change-of-mode icons
    for (const leg of j.legs) {
      if (leg.kind === 'station') continue;
      // A change of mode (get on or off, change lines) is marked where the next leg
      // starts; the bicicletário marker already marks its own.
      if (prev && prev.kind !== 'park' && leg.kind !== 'park' && (prev.kind !== leg.kind || leg.kind === 'ride')) {
        const at = legStart(leg);
        L.marker(at, { pane: 'planPins', icon: transferIcon, interactive: false, keyboard: false }).addTo(routeLayer);
      }
      prev = leg;
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
      const glyph = glyphOf(leg);
      // Taps on the route open its tooltip; they must not reach the map, which would
      // add a trip point there.
      if (glyph) {
        const line = L.polyline(path, { renderer, color, weight: 3, opacity: 0.55, bubblingMouseEvents: false }).addTo(routeLayer);
        if (leg.kind === 'ride') line.bindTooltip(`${lineName(leg)} · sentido ${esc(leg.headsign.trim())}`);
        const n = leg.kind === 'ride' && rideCount[glyph] > 1 ? (rideSeen[glyph] = (rideSeen[glyph] ?? 0) + 1) : null;
        iconLegs.push({ path, glyph, color, n });
      } else {
        L.polyline(path, { renderer, color: '#ffffff', weight: 7, opacity: 0.8, interactive: false }).addTo(routeLayer);
        L.polyline(path, { renderer, color, weight: 4, dashArray: '1 7', lineCap: 'round', bubblingMouseEvents: false }).addTo(routeLayer);
      }
      for (const p of path) bounds.extend(p);
      if (leg.interchange) continue;
      const meters = leg.meters || pathLength(path);
      labelLegs.push({
        path,
        info: `${minutes(leg.arrive - leg.depart)} · ${kcal(leg.kcal)} · ${km(meters)}`,
        line: leg.kind === 'ride' ? String(leg.mode === 'bus' ? leg.route : `Linha ${leg.rail}`) : null,
        color,
      });
    }
    if (!bounds.isValid()) return;
    for (const p of stops) if (p) bounds.extend([p.lat, p.lon]);
    // Keep the route clear of the menu sheet and the map buttons.
    const inset = sheetInsets();
    map.fitBounds(bounds, {
      paddingTopLeft: [inset.left + 30, 30],
      paddingBottomRight: [70, inset.bottom + 30],
      maxZoom: 16,
    });
    placeIcons();
    placeLabels();
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

  const legStart = (leg) => (leg.path?.[0] ?? [leg.from.lat, leg.from.lon]);

  // Where the trip changes mode: two arrows swapping, on a dark disc.
  const transferIcon = L.divIcon({
    className: 'plan-transfer',
    html: '<span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5"/></svg></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  function trailIcon(glyph, color, angle, n) {
    // Rails turn with the track; the bike faces where it's going; the wheel doesn't care.
    const turn = glyph === 'rail' ? `rotate(${angle + 90}deg)` : glyph === 'bike' && Math.cos((angle * Math.PI) / 180) < 0 ? 'scaleX(-1)' : '';
    return L.divIcon({
      className: 'plan-trail',
      html: `<span style="background:${color}"><svg viewBox="0 0 24 24" style="transform:${turn}">${GLYPHS[glyph]}</svg>${n ? `<sub style="background:${color}">${n}</sub>` : ''}</span>`,
      iconSize: [ICON_SIZE, ICON_SIZE],
      iconAnchor: [ICON_SIZE / 2, ICON_SIZE / 2],
    });
  }

  // Icons every ICON_GAP px along each leg, only where the map shows them.
  function placeIcons() {
    iconLayer.clearLayers();
    if (!iconLegs.length) return;
    const view = map.getPixelBounds().pad(0.1);
    for (const { path, glyph, color, n } of iconLegs) {
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
            L.marker(map.unproject(p), { pane: 'planIcons', icon: trailIcon(glyph, color, angle, n), interactive: false, keyboard: false }).addTo(iconLayer);
          }
          next += ICON_GAP;
        }
        walked += len;
      }
    }
  }
  map.on('zoomend moveend', placeIcons);

  // ---------------------------------------------------------------- leg labels

  // Each leg is labelled with text that follows the line itself (SVG textPath): time,
  // energy and distance above it, the bus or rail line below (rides only). The text
  // runs along an invisible copy of the leg, turned west→east so it never reads upside
  // down. A label longer than its leg on screen gets a smaller font (fitLabels()).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let labelLegs = []; // { path, info, line, color } of the selected journey
  let labelTexts = []; // [{ guide: SVGPathElement, texts: [SVGTextElement] }]

  function pathLength(path) {
    let m = 0;
    for (let i = 1; i < path.length; i++) m += map.distance(path[i - 1], path[i]);
    return m;
  }

  function clearLabels() {
    for (const { texts } of labelTexts) for (const t of texts) t.remove();
    labelTexts = [];
  }

  function textOn(guide, content, dy, className, outline) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', className);
    text.setAttribute('dy', String(dy));
    text.style.stroke = outline; // white letters outlined in the leg's colour
    const tp = document.createElementNS(SVG_NS, 'textPath');
    tp.setAttribute('href', `#${guide.id}`);
    tp.setAttribute('startOffset', '50%'); // moved to the visible middle by fitLabels()
    tp.setAttribute('text-anchor', 'middle');
    tp.textContent = content;
    text.append(tp);
    guide.parentNode.append(text);
    return text;
  }

  // The guide is simplified on screen with a tolerance of 15% of the leg's size there
  // (zigzags through the street grid become one gentle curve, at any zoom) and then
  // rounded with four Chaikin passes, so the text bends instead of folding at corners.
  const chaikin = (pts) => {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push(a.multiplyBy(0.75).add(b.multiplyBy(0.25)), a.multiplyBy(0.25).add(b.multiplyBy(0.75)));
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  const SmoothGuide = L.Polyline.extend({
    _update() {
      if (!this._map) return;
      this._clipPoints();
      const size = this._pxBounds?.getSize();
      this.options.smoothFactor = size ? Math.max(8, Math.hypot(size.x, size.y) * 0.15) : 8;
      this._simplifyPoints();
      this._parts = this._parts.map((part) => chaikin(chaikin(chaikin(chaikin(part)))));
      this._updatePath();
    },
  });

  let guideId = 0;
  function placeLabels() {
    clearLabels();
    for (const { path, info, line, color } of labelLegs) {
      const westToEast = path[path.length - 1][1] >= path[0][1] ? path : [...path].reverse();
      const guide = new SmoothGuide(westToEast, { renderer, opacity: 0, weight: 1, interactive: false, noClip: true }).addTo(routeLayer);
      const el = guide.getElement();
      if (!el) continue;
      el.id = `plan-guide-${++guideId}`;
      // Above the line, clear of the icon trail; the line's name below it. Their size
      // is set by fitLabels().
      const texts = [textOn(el, info, -17, 'plan-leg-label', color)];
      if (line) texts.push(textOn(el, line, 28, 'plan-leg-label line', color));
      labelTexts.push({ guide: el, texts });
    }
    requestAnimationFrame(fitLabels);
  }

  // Each label sits on the straightest stretch of the part of its leg that's on screen
  // (not under the sheet or the map buttons; letters on the outside of a sharp bend
  // would spread apart), shrinking to fit that part down to MIN_LABEL_PX;
  // below that it fades out. When the view changes, labels glide along the line to
  // their new spot and size instead of jumping. Tight corners may squeeze the letters.
  const MIN_LABEL_PX = 7;
  const GLIDE_MS = 300;
  const SAMPLE_PX = 6;
  const state = new WeakMap(); // text -> { frac, size, raf }

  /** The view in the guides' coordinates (layer points), minus what covers the map. */
  function visibleRect() {
    const size = map.getSize();
    const inset = sheetInsets();
    const a = map.containerPointToLayerPoint([inset.left + 12, 12]);
    const b = map.containerPointToLayerPoint([size.x - 64, size.y - inset.bottom - 12]);
    return L.bounds(a, b);
  }

  /**
   * Where along the guide (px) to centre a label `width` px long inside `stretch`: the
   * spot where the line turns least under the label, ties going to the middle.
   */
  function straightestCentre(guide, stretch, width) {
    const from = stretch.from + width / 2, to = stretch.to - width / 2;
    const middle = (stretch.from + stretch.to) / 2;
    if (to <= from) return middle;
    const angles = [];
    for (let d = stretch.from; d <= stretch.to; d += SAMPLE_PX) {
      const a = guide.getPointAtLength(d), b = guide.getPointAtLength(Math.min(stretch.to, d + SAMPLE_PX));
      angles.push(Math.atan2(b.y - a.y, b.x - a.x));
    }
    const turnAt = (i) => {
      let t = Math.abs(angles[i] - angles[i - 1]);
      return t > Math.PI ? 2 * Math.PI - t : t;
    };
    let best = middle, bestScore = Infinity;
    const half = Math.round(width / 2 / SAMPLE_PX);
    for (let c = from; c <= to; c += SAMPLE_PX) {
      const ci = Math.round((c - stretch.from) / SAMPLE_PX);
      let turn = 0;
      for (let i = Math.max(1, ci - half); i <= Math.min(angles.length - 1, ci + half); i++) turn += turnAt(i);
      const score = turn + Math.abs(c - middle) / 2000; // radians, plus a nudge to the middle
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /** Longest on-screen stretch of the guide: { from, to } in px along it, or null. */
  function visibleStretch(guide, total, rect) {
    let best = null, runStart = null, last = 0;
    for (let d = 0; d <= total; d += SAMPLE_PX) {
      const p = guide.getPointAtLength(d);
      if (rect.contains([p.x, p.y])) {
        runStart ??= d;
        last = d;
      } else if (runStart != null) {
        if (!best || last - runStart > best.to - best.from) best = { from: runStart, to: last };
        runStart = null;
      }
    }
    if (runStart != null && (!best || last - runStart > best.to - best.from)) best = { from: runStart, to: last };
    return best;
  }

  function glide(t, target, total) {
    const st = state.get(t) ?? { frac: target.frac, size: target.size };
    cancelAnimationFrame(st.raf);
    const from = { frac: st.frac, size: st.size }, t0 = performance.now();
    const apply = (frac, size) => {
      st.frac = frac; st.size = size;
      t.firstChild.setAttribute('startOffset', String(frac * total));
      t.style.fontSize = `${size.toFixed(2)}px`;
      t.style.strokeWidth = `${Math.max(2, (4 * size) / target.base).toFixed(2)}px`;
    };
    const step = (now) => {
      const k = Math.min(1, (now - t0) / GLIDE_MS), e = 1 - (1 - k) ** 3;
      apply(from.frac + (target.frac - from.frac) * e, from.size + (target.size - from.size) * e);
      if (k < 1) st.raf = requestAnimationFrame(step);
    };
    state.set(t, st);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) apply(target.frac, target.size);
    else st.raf = requestAnimationFrame(step);
  }

  function fitLabels() {
    const rect = visibleRect();
    for (const { guide, texts } of labelTexts) {
      const total = guide.getTotalLength?.() ?? 0;
      const stretch = total ? visibleStretch(guide, total, rect) : null;
      for (const t of texts) {
        const base = t.classList.contains('line') ? 13.5 : 12.5;
        if (!stretch) { t.style.opacity = '0'; continue; }
        // Text length at the base size (getComputedTextLength scales with the font).
        const now = parseFloat(t.style.fontSize) || base;
        const length = (t.getComputedTextLength() * base) / now;
        const room = stretch.to - stretch.from - 16;
        const size = Math.min(base, (base * room) / length);
        if (size < MIN_LABEL_PX) { t.style.opacity = '0'; continue; }
        t.style.opacity = '1';
        const centre = straightestCentre(guide, stretch, (length * size) / base + 16);
        glide(t, { frac: centre / total, size, base }, total);
      }
    }
  }

  // After Leaflet has redrawn the guides at the new zoom.
  map.on('moveend', () => requestAnimationFrame(fitLabels));
}
