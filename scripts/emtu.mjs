// EMTU seletivo lines: routes, stops and a GTFS feed from rest-emtu.noxxonsat.com.br
// (lineDetails), the feed behind EMTU's own apps. Used by build-data.mjs (`emtu`).

import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

import { EMTU_SENTIDO } from '../functions/_lib/emtu.js';
import { decodePolyline, round, simplify } from '../functions/_lib/geometry.js';
import { dayType } from '../public/js/schedule.js';
import { holidays, weekdayOf } from '../public/js/time.js';

const EMTU_HOST = 'rest-emtu.noxxonsat.com.br';

/**
 * GET from the EMTU feed. Its certificate expired in April 2025: that one error is
 * accepted, for this host only. The chain and the host name are still checked.
 * (relay/server.mjs has the same function: the relay is deployed on its own.)
 */
export function emtuGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: EMTU_HOST, path, agent: false, rejectUnauthorized: false, timeout: 30_000, headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`EMTU ${path}: HTTP ${res.statusCode}`));
        resolve(Buffer.concat(chunks));
      });
    });
    // A fresh connection per request (agent: false), so every one goes through this check.
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const err = socket.authorized ? null
        : socket.authorizationError !== 'CERT_HAS_EXPIRED' ? new Error(`EMTU TLS: ${socket.authorizationError}`)
        : checkServerIdentity(EMTU_HOST, socket.getPeerCertificate());
      if (err) req.destroy(err);
    }));
    req.on('timeout', () => req.destroy(new Error(`EMTU ${path}: timeout`)));
    req.on('error', reject);
    req.end();
  });
}

/** "Rua X, 130 - Centro, Osasco - SP, 06020-012, Brasil" -> "Rua X, 130 - Centro, Osasco". */
export function stopName(address) {
  return String(address ?? '')
    .replace(/,\s*Brasil\s*$/i, '')
    .replace(/,?\s*\d{5}-?\d{3}\s*$/, '')
    .replace(/\s*-\s*SP\s*$/, '')
    .trim();
}

const SMALL_WORDS = new Set(['de', 'do', 'da', 'dos', 'das', 'e', 'via']);
/** "SAO PAULO (TERMINAL RODOVIARIO TIETE)" -> "Sao Paulo (Terminal Rodoviario Tiete)". */
export function titleCase(text) {
  return String(text ?? '').toLowerCase().replace(/[\p{L}\p{N}]+/gu, (w, at) =>
    (at > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

/**
 * `details` maps line code to its lineDetails answer; `config` is
 * public/data/emtu-seletivo.json. Returns GeoJSON features (routes without lanes yet,
 * stops), and the configured lines the feed doesn't know.
 */
export function emtuFeatures(details, config) {
  const routes = [], stops = new Map(), missing = [];
  for (const { code, name, operator } of config.lines) {
    const line = details[code]?.linhas?.find((l) => l.codigo === code);
    if (!line?.rotas?.length) {
      missing.push(code);
      continue;
    }
    for (const r of line.rotas) {
      const coordinates = simplify(decodePolyline(r.encode ?? '').map(([lon, lat]) => [round(lon), round(lat)]));
      if (coordinates.length < 2) continue;
      routes.push({
        type: 'Feature',
        properties: {
          code, name, operator, agency: 'emtu', fare: line.tarifa ?? null,
          sentido: EMTU_SENTIDO[r.sentido] ?? 1,
          headsign: titleCase(r.destino),
        },
        geometry: { type: 'LineString', coordinates },
      });
      for (const p of r.pontos ?? []) {
        const id = `emtu-${p.id}`;
        if (!stops.has(id)) {
          stops.set(id, {
            type: 'Feature',
            properties: { id, name: stopName(p.endereco), lines: [] },
            geometry: { type: 'Point', coordinates: [round(p.longitude), round(p.latitude)] },
          });
        }
        const lines = stops.get(id).properties.lines;
        if (!lines.includes(code)) lines.push(code);
      }
    }
  }
  return { routes, stops: [...stops.values()], missing };
}

// ---------------------------------------------------------------- GTFS

// EMTU publishes no current GTFS. lineDetails has, per line and direction, the stops in
// order, the route, a trip time (`tempo`, minutes) and the departures from the first
// stop per day type. Times at the other stops are spread along the route by distance:
// estimates, hence timepoint=0. Lines whose per-day lists are empty only fill
// `horarios`, the timetable of the day the feed was read.

const SERVICES = { weekday: 'emtu-weekday', saturday: 'emtu-saturday', sunday: 'emtu-sunday' };
const SERVICE_DAYS = {
  weekday: [1, 1, 1, 1, 1, 0, 0],
  saturday: [0, 0, 0, 0, 0, 1, 0],
  sunday: [0, 0, 0, 0, 0, 0, 1],
};
const GTFS_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FEED_DAYS = 365;

/** "4:40,5:15,23:50,0:20" -> seconds since midnight, past 24 h after a wrap. */
export function departures(list) {
  const out = [];
  let prev = -1, extra = 0;
  for (const hm of String(list ?? '').split(',')) {
    const m = hm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    let t = (+m[1] * 60 + +m[2]) * 60 + extra;
    if (t < prev) { extra += 86_400; t += 86_400; }
    out.push(t);
    prev = t;
  }
  return out;
}

const gtfsTime = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':');
const gtfsDate = (iso) => iso.replaceAll('-', '');
function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Distance (m) of each point along `line` ([lon, lat] both), in order. Each point has
 * a few candidate spots on the route (the nearest one of every stretch that passes
 * within NEAR_M, or else the nearest overall); the in-order choice with the least
 * total distance wins, so a route that passes a stop twice takes the right pass.
 */
const NEAR_M = 150;
export function distancesAlong(line, points) {
  if (line.length < 2) return null;
  const ky = 110_540, kx = 111_320 * Math.cos((line[0][1] * Math.PI) / 180);
  const xy = line.map(([lon, lat]) => [lon * kx, lat * ky]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));

  const candidates = points.map(([lon, lat]) => {
    const px = lon * kx, py = lat * ky;
    const runs = [];
    let nearest = null, run = null;
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const f = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const c = { d: Math.hypot(ax + f * dx - px, ay + f * dy - py), along: cum[i] + f * (cum[i + 1] - cum[i]) };
      if (!nearest || c.d < nearest.d) nearest = c;
      if (c.d <= NEAR_M) {
        if (!run) runs.push((run = c));
        else if (c.d < run.d) runs[runs.length - 1] = run = c;
      } else run = null;
    }
    return runs.length ? runs : [nearest];
  });

  // cost = distance off the route, plus a little per metre travelled, so ties go to
  // the earlier spot; a choice behind the previous stop is not allowed.
  const steps = [];
  let prev = [{ along: 0, cost: 0, from: -1 }];
  for (const cands of candidates) {
    const next = cands.map((c) => {
      let best = null;
      prev.forEach((p, j) => {
        if (c.along < p.along) return;
        const cost = p.cost + c.d + 0.001 * (c.along - p.along);
        if (!best || cost < best.cost) best = { along: c.along, cost, from: j };
      });
      return best;
    }).filter(Boolean);
    // Nothing ahead (a stop the route doesn't reach in order): stay where we are.
    if (!next.length) {
      const p = prev.reduce((a, b) => (b.cost < a.cost ? b : a));
      next.push({ along: p.along, cost: p.cost, from: prev.indexOf(p) });
    }
    steps.push(next);
    prev = next;
  }
  const out = new Array(points.length);
  let k = prev.indexOf(prev.reduce((a, b) => (b.cost < a.cost ? b : a)));
  for (let i = steps.length - 1; i >= 0; i--) {
    out[i] = steps[i][k].along;
    k = steps[i][k].from;
  }
  return out;
}

/** Rows (objects) -> CSV text with a header, quoting where needed. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`;
}

/**
 * GTFS tables ({ 'routes.txt': [row, ...], ... }) of the seletivo lines. `today` (ISO
 * date, São Paulo) starts the calendar and gives the day type of `horarios`.
 */
export function emtuGtfs(details, config, { today }) {
  const fetchedType = dayType(today) === 'holiday' ? 'sunday' : dayType(today);
  const routes = [], trips = [], stopTimes = [], shapes = [], stops = new Map();
  for (const { code, name, operator } of config.lines) {
    const line = details[code]?.linhas?.find((l) => l.codigo === code);
    if (!line?.rotas?.length) continue;
    routes.push({
      route_id: code, agency_id: 'EMTU', route_short_name: code, route_long_name: name,
      route_desc: `Seletivo${operator ? ` · ${operator}` : ''} · bicicleta no bagageiro, se houver espaço (sem regra publicada pela EMTU)`,
      route_type: 3, route_color: '0E7490', route_text_color: 'FFFFFF',
    });
    for (const r of line.rotas) {
      const pontos = [...(r.pontos ?? [])].sort((a, b) => a.sequencia - b.sequencia);
      if (pontos.length < 2 || !(r.tempo > 0)) continue;
      const dir = (EMTU_SENTIDO[r.sentido] ?? 1) - 1;
      const shapeId = `${code}-${r.sentido}`;
      const shape = simplify(decodePolyline(r.encode ?? '').map(([lon, lat]) => [round(lon), round(lat)]));
      const pts = pontos.map((p) => [p.longitude, p.latitude]);
      let along = distancesAlong(shape, pts);
      if (!along || along.at(-1) <= 0) {
        // No usable route: straight lines between stops.
        along = [0];
        for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + 111_000 * Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      }
      // Times count from the first stop, wherever it sits on the route.
      const total = r.tempo * 60, length = along.at(-1) - along[0] || 1;
      const offsets = along.map((d) => Math.round((total * (d - along[0])) / length));
      if (shape.length >= 2) {
        let d = 0;
        shape.forEach(([lon, lat], i) => {
          if (i) d += 111_000 * Math.hypot((lon - shape[i - 1][0]) * Math.cos((lat * Math.PI) / 180), lat - shape[i - 1][1]);
          shapes.push({ shape_id: shapeId, shape_pt_lat: lat, shape_pt_lon: lon, shape_pt_sequence: i, shape_dist_traveled: Math.round(d) });
        });
      }
      for (const p of pontos) {
        const id = `emtu-${p.id}`;
        if (!stops.has(id)) stops.set(id, { stop_id: id, stop_name: stopName(p.endereco), stop_lat: round(p.latitude), stop_lon: round(p.longitude) });
      }
      const lists = { weekday: r.horariosdiasuteis, saturday: r.horariossabados, sunday: r.horariosdomingosferiados };
      if (!Object.values(lists).some(Boolean)) lists[fetchedType] = r.horarios;
      for (const [type, list] of Object.entries(lists)) {
        for (const dep of new Set(departures(list))) {
          const tripId = `${shapeId}-${type}-${gtfsTime(dep).slice(0, 5).replace(':', '')}`;
          trips.push({
            route_id: code, service_id: SERVICES[type], trip_id: tripId, trip_headsign: titleCase(r.destino),
            direction_id: dir, shape_id: shape.length >= 2 ? shapeId : '', bikes_allowed: 1,
          });
          pontos.forEach((p, i) => {
            const t = gtfsTime(dep + offsets[i]);
            stopTimes.push({ trip_id: tripId, arrival_time: t, departure_time: t, stop_id: `emtu-${p.id}`, stop_sequence: i, timepoint: i === 0 ? 1 : 0 });
          });
        }
      }
    }
  }

  const end = addDays(today, FEED_DAYS);
  const calendar = Object.entries(SERVICES).map(([type, id]) => ({
    service_id: id,
    ...Object.fromEntries(GTFS_DAYS.map((d, i) => [d, SERVICE_DAYS[type][i]])),
    start_date: gtfsDate(today), end_date: gtfsDate(end),
  }));
  // Holidays run the Sunday timetable (the feed's "domingos e feriados").
  const calendarDates = [];
  for (const year of new Set([today.slice(0, 4), end.slice(0, 4)])) {
    for (const iso of holidays(+year).keys()) {
      if (iso < today || iso > end) continue;
      const wd = weekdayOf(iso);
      if (wd === 0) continue;
      calendarDates.push({ service_id: SERVICES[wd === 6 ? 'saturday' : 'weekday'], date: gtfsDate(iso), exception_type: 2 });
      calendarDates.push({ service_id: SERVICES.sunday, date: gtfsDate(iso), exception_type: 1 });
    }
  }
  calendarDates.sort((a, b) => a.date.localeCompare(b.date) || a.service_id.localeCompare(b.service_id));

  return {
    'agency.txt': [{ agency_id: 'EMTU', agency_name: 'EMTU/SP', agency_url: 'https://www.emtu.sp.gov.br', agency_timezone: 'America/Sao_Paulo', agency_lang: 'pt' }],
    'routes.txt': routes,
    'stops.txt': [...stops.values()],
    'trips.txt': trips,
    'stop_times.txt': stopTimes,
    'calendar.txt': calendar,
    'calendar_dates.txt': calendarDates,
    'shapes.txt': shapes,
    'feed_info.txt': [{
      feed_publisher_name: 'Bici Busão Sampa', feed_publisher_url: 'https://busao.bicisampa.info', feed_lang: 'pt',
      feed_contact_url: 'https://github.com/danlessa/bicibusaosampa/issues',
      feed_start_date: gtfsDate(today), feed_end_date: gtfsDate(end), feed_version: today,
    }],
  };
}
