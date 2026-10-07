// Intermodal trip planner: walking, cycling, Metrô/CPTM and SPTrans buses. RAPTOR
// (Delling, Pajor & Werneck, 2012) over the frequency-based patterns of
// data/routing/transit.json (built by scripts/routing.mjs).
//
// Every stop exists twice: without the bike (layer 0) and with it (layer 1).
//   - Without the bike: any line, walking between stops.
//   - With the bike: rail inside its bike hours and bicycle-enabled buses (Articulado
//     23m) inside the bus bike hours; riding between stops. A bicycle-enabled bus is a
//     vehicle, not a line: with live data, the 23m buses on the road (live-trips.js)
//     are the trips, whatever line they run. Without it, or past the live horizon, the
//     usual lines in bike-buses.json stand in for them.
//   - The bike can be left at a bicicletário near a stop (layer 1 → 0), never picked up.
//
// Each label carries two criteria, arrival time and energy (McRAPTOR), so the planner
// can offer the fastest trip and the least effort one. Energy is net metabolic (above
// resting): pedalling and walking from streets.js, 0.3 MET on board or waiting.
//
// Walking and cycling legs follow the street graph (streets.js) where it covers; outside
// it, or without it, they are straight lines times DETOUR on flat ground. Times are
// seconds since midnight of the query day, São Paulo time.

import { currentService } from './rail.js';
import { dayType, toMinutes, windowsFor } from './schedule.js';
import { bikeModel, flatLeg, PASSIVE_W, pathNodes, snap, snapAround, streetSearch } from './streets.js';
import { previousDay, spParts } from './time.js';

export const INF = 0x3fffffff;
export const DETOUR = 1.3;             // street distance / straight-line distance, without the graph
export const POWER_LEVELS = { suave: 40, endorfinado: 80, intenso: 110, competicao: 150 };

const LIMITS = {
  walkTransfer: 400,    // m, straight line, between stops
  bikeTransfer: 1000,
  parking: 250,         // bicicletário to stop
  snap: 500,            // farthest a point may be from the street graph
};
const CHANGE_S = 60;          // getting off one vehicle and onto the next at the same stop
const PARK_S = 180;           // locking the bike at a bicicletário
// Effort of getting on board (J): stairs, gates and the last car, with or without the
// bike. Keeps "least effort" from collecting one-stop rides.
const BOARD_J = { bus: [8_000, 20_000], rail: [8_000, 40_000] };
const LIVE_HORIZON_S = 2400;  // past this, usual lines stand in for live 23m buses
const MAX_ROUNDS = 4;         // transit legs
// Labels this close in both criteria count as the same option.
const SLACK_S = 60, SLACK_J = 20_000;
// "Mais rápido": options slower than the fastest by more than this aren't worth
// showing. "Menos esforço" ignores time. Either way, no trip (nor any walk or ride in
// it) is longer than MAX_TRIP_S, so the search stays finite; there's no distance limit.
const slowest = (fastest, now) => fastest + Math.max(15 * 60, 0.3 * (fastest - now));
const MAX_TRIP_S = 3 * 3600;
const MAX_JOURNEYS = 6;

const ACCESS = 1, RIDE = 2, TRANSFER = 3, PARK = 4, EGRESS = 5, DIRECT = 6;

/** Cruising speed (m/s) on flat ground at `power` W. */
export function flatSpeed(power) {
  return bikeModel(power).vFlat;
}

// ------------------------------------------------------------------ geometry

const KY = 110_574;
const KX = 111_320 * Math.cos((-23.55 * Math.PI) / 180);
/** Metres per degree of longitude and latitude around São Paulo. */
export const KX_KY = [KX, KY];

export function meters(lat1, lon1, lat2, lon2) {
  return Math.hypot((lat2 - lat1) * KY, (lon2 - lon1) * KX);
}

const CELL = 0.01; // degrees, ~1 km

class Grid {
  constructor(lat, lon) {
    this.lat = lat; this.lon = lon;
    this.cells = new Map();
    for (let i = 0; i < lat.length; i++) {
      const key = this.key(Math.floor(lat[i] / CELL), Math.floor(lon[i] / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
  }

  key(r, c) { return r * 100_000 + c; }

  /** Calls fn(index, meters) for every point within `radius` m of (lat, lon). */
  near(lat, lon, radius, fn) {
    const dr = Math.ceil(radius / KY / CELL), dc = Math.ceil(radius / KX / CELL);
    const r0 = Math.floor(lat / CELL), c0 = Math.floor(lon / CELL);
    for (let r = r0 - dr; r <= r0 + dr; r++) {
      for (let c = c0 - dc; c <= c0 + dc; c++) {
        const list = this.cells.get(this.key(r, c));
        if (!list) continue;
        for (const i of list) {
          const d = meters(lat, lon, this.lat[i], this.lon[i]);
          if (d <= radius) fn(i, d);
        }
      }
    }
  }
}

function csr(n, pairs) {
  const ptr = new Uint32Array(n + 1);
  for (const [from] of pairs) ptr[from + 1]++;
  for (let i = 0; i < n; i++) ptr[i + 1] += ptr[i];
  const to = new Int32Array(pairs.length), dist = new Float32Array(pairs.length);
  const cur = ptr.slice(0, n);
  for (const [from, t, d] of pairs) { const k = cur[from]++; to[k] = t; dist[k] = d; }
  return { ptr, to, dist };
}

// ------------------------------------------------------------------ network

/**
 * Prepares the network for queries.
 * transit: data/routing/transit.json; railLines: data/rail-lines.json;
 * bikeBuses: data/bike-buses.json; parking: data/bike-parking.geojson;
 * streets: decodeStreets(data/routing/streets.bin), or null for straight lines.
 */
export function loadNetwork({ transit, railLines, bikeBuses, parking, streets = null }) {
  const S = transit.stops.id.length;
  const lat = Float64Array.from(transit.stops.lat), lon = Float64Array.from(transit.stops.lon);
  const grid = new Grid(lat, lon);
  const usual = new Set(bikeBuses.lines.map((l) => l.code));

  const patterns = transit.patterns.map((p) => ({
    route: p.route, dir: p.dir, mode: p.mode, rail: p.rail, headsign: p.headsign, service: p.service,
    stops: Int32Array.from(p.stops),
    offsets: Int32Array.from(p.offsets),
    departures: Int32Array.from(p.departures),
    usualBikeBus: p.mode === 'bus' && usual.has(p.route),
  }));

  const byRouteDir = new Map();
  const servedBy = [];
  patterns.forEach((p, pi) => {
    const key = `${p.route}|${p.dir}`;
    if (!byRouteDir.has(key)) byRouteDir.set(key, []);
    byRouteDir.get(key).push(pi);
    p.stops.forEach((s, i) => servedBy.push([s, pi, i]));
  });
  const stopPatterns = csr(S, servedBy);   // to = pattern, dist = index along it

  const walk = [], bike = [];
  for (let s = 0; s < S; s++) {
    grid.near(lat[s], lon[s], LIMITS.bikeTransfer, (t, d) => {
      if (t === s) return;
      bike.push([s, t, d]);
      if (d <= LIMITS.walkTransfer) walk.push([s, t, d]);
    });
  }

  // Bicicletários where a bike can stay for hours; open street stands (paraciclos) are left out.
  const lots = parking.features
    .filter((f) => f.properties.kind === 'bicicletario' && ['livre', 'cadastro', 'pago'].includes(f.properties.access))
    .map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  const parkingAt = new Int32Array(S).fill(-1);
  const parkingDist = new Float32Array(S).fill(Infinity);
  lots.forEach((lot, li) => grid.near(lot.lat, lot.lon, LIMITS.parking, (s, d) => {
    if (d < parkingDist[s]) { parkingDist[s] = d; parkingAt[s] = li; }
  }));

  // Where each stop meets the street graph, for walking and for cycling: a few nodes
  // around it (stations sit between the tracks, with exits on both sides).
  const railStop = new Uint8Array(S);
  for (const p of patterns) if (p.mode !== 'bus') for (const s of p.stops) railStop[s] = 1;
  const stopLinks = [[], []];
  if (streets) {
    ['walk', 'bike'].forEach((mode, layer) => {
      const pairs = [];
      for (let s = 0; s < S; s++) {
        for (const hit of snapAround(streets, lat[s], lon[s], mode, railStop[s] ? 300 : 150, railStop[s] ? 4 : 2)) pairs.push([s, hit.node, hit.meters]);
      }
      stopLinks[layer] = csr(S, pairs); // to = street node, dist = metres
    });
  }

  return {
    stops: { id: transit.stops.id, name: transit.stops.name, lat, lon, count: S },
    streets, stopLinks,
    grid, patterns, byRouteDir, stopPatterns,
    walkTransfers: csr(S, walk), bikeTransfers: csr(S, bike),
    lots, parkingAt,
    services: transit.services,
    railLines: new Map(railLines.lines.map((l) => [l.ref, l])),
    railBikes: railLines.bikeRules.bikes,
    busBikes: bikeBuses.rules.bikes,
  };
}

// ------------------------------------------------------------------ query day

function nextDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Time context of a query: day start, active services and minute masks for the rules. */
export function queryDay(net, date) {
  const parts = spParts(date);
  const now = parts.minutes * 60 + date.getUTCSeconds();
  const dayStartMs = date.getTime() - now * 1000 - date.getUTCMilliseconds();
  const types = [dayType(previousDay(parts.iso)), dayType(parts.iso), dayType(nextDay(parts.iso))];

  // 1 for each minute of today and tomorrow (0..2879) inside one of the schedule's windows.
  const mask = (schedule) => {
    const m = new Uint8Array(2880);
    types.forEach((type, day) => {
      for (const [s, e] of windowsFor(schedule, type)) {
        const from = Math.max(0, toMinutes(s) + (day - 1) * 1440), to = Math.min(2880, toMinutes(e) + (day - 1) * 1440);
        for (let i = from; i < to; i++) m[i] = 1;
      }
    });
    return m;
  };

  const column = types[1] === 'holiday' ? 6 : (parts.weekday + 6) % 7; // GTFS calendar: Mon..Sun
  const railOpen = new Map(), railBike = new Map();
  for (const [ref, line] of net.railLines) {
    const open = mask(currentService(line, date)), bikes = mask(line.bikes ?? net.railBikes);
    railOpen.set(ref, open);
    railBike.set(ref, open.map((v, i) => v & bikes[i]));
  }
  return {
    date, now, dayStartMs,
    active: net.patterns.map((p) => net.services[p.service]?.[column] === 1),
    railOpen, railBike,
    busBike: mask(net.busBikes),
    lotOpen: net.lots.map((lot) => (lot.hours && lot.hours !== '24h' ? mask(lot.hours) : null)),
  };
}

const inMask = (m, t) => {
  const i = Math.floor(t / 60);
  return i >= 0 && i < 2880 && m[i] === 1;
};

// ------------------------------------------------------------------ trips

/** Scheduled trips of a pattern: trip h departs its first stop at departures[h]. */
function scheduled(p, gate, info = {}) {
  const dep = p.departures, off = p.offsets;
  return {
    time: (h, i) => dep[h] + off[i],
    earliest(i, t) {
      let lo = 0, hi = dep.length;
      const need = t - off[i];
      while (lo < hi) { const mid = (lo + hi) >> 1; if (dep[mid] < need) lo = mid + 1; else hi = mid; }
      for (let h = lo; h < dep.length; h++) if (gate(dep[h] + off[i])) return h;
      return -1;
    },
    info: () => info,
  };
}

/** Explicit trips (live 23m buses, plus usual-line trips past the live horizon). */
function explicit(trips, gate) {
  return {
    time: (h, i) => trips[h].times[i],
    earliest(i, t) {
      let best = -1, bt = INF;
      for (let h = 0; h < trips.length; h++) {
        const x = trips[h].times[i];
        if (x >= t && x < bt && gate(x)) { best = h; bt = x; }
      }
      return best;
    },
    info: (h) => (trips[h].prefix ? { live: trips[h].prefix } : { estimated: true }),
  };
}

function provider(net, day, live, pi, layer) {
  const p = net.patterns[pi];
  if (p.mode !== 'bus') {
    const m = (layer ? day.railBike : day.railOpen).get(p.rail);
    if (!m) return null;
    return day.active[pi] ? scheduled(p, (t) => inMask(m, t)) : null;
  }
  if (layer === 0) return day.active[pi] ? scheduled(p, () => true) : null;

  const gate = (t) => inMask(day.busBike, t);
  if (!live) return day.active[pi] && p.usualBikeBus ? scheduled(p, gate, { estimated: true }) : null;
  const trips = [...(live.get(pi) ?? [])];
  if (day.active[pi] && p.usualBikeBus) {
    // Past the live horizon the usual lines stand in for buses not on the road yet.
    const horizon = day.now + LIVE_HORIZON_S;
    for (const d of p.departures) {
      const times = new Int32Array(p.stops.length);
      let any = false;
      for (let i = 0; i < times.length; i++) {
        const t = d + p.offsets[i];
        times[i] = t >= horizon ? t : INF;
        any ||= t >= horizon;
      }
      if (any) trips.push({ times });
    }
  }
  return trips.length ? explicit(trips, gate) : null;
}

// ------------------------------------------------------------------ search

export const PROFILES = {
  // Access layer, egress layers, and whether the bike may be left at a bicicletário.
  walk: { access: 0, egress: [0], park: false },
  bike: { access: 1, egress: [0, 1], park: true },
  carry: { access: 1, egress: [1], park: false },  // never leaves the bike
};

const MODE = ['walk', 'bike'];

/** Is (t, e) as good as some option in `list`, within the slack? */
function covered(list, t, e) {
  if (!list) return false;
  for (const l of list) if (l.t <= t + SLACK_S && l.e <= e + SLACK_J) return true;
  return false;
}

/** Adds `label` to a Pareto list, dropping what it strictly beats. */
function insert(list, label) {
  for (let i = list.length - 1; i >= 0; i--) if (label.t <= list[i].t && label.e <= list[i].e) list.splice(i, 1);
  list.push(label);
}

/**
 * Journeys from `from` to `to` ({ lat, lon }) leaving at `date`: the Pareto options in
 * arrival time and energy, sorted by `optimize`: 'time' keeps those within a cap of
 * the fastest; 'energy' keeps the least effort ones whatever they take (up to
 * MAX_TRIP_S). `live`: Map pattern → trips from live-trips.js, or null.
 */
export function plan(net, { from, to, date = new Date(), profile = 'bike', power = POWER_LEVELS.endorfinado, optimize = 'time', live = null, day = null }) {
  const prof = PROFILES[profile];
  day ??= queryDay(net, date);
  const bike = bikeModel(power);
  const S = net.stops.count;
  const { lat, lon } = net.stops;
  const g = net.streets;
  const flat = (layer, m, detour = DETOUR) => flatLeg(MODE[layer], m, bike, detour);
  const fromPt = { name: 'Origem', ...from }, toPt = { name: 'Destino', ...to };
  const stopPt = (s) => ({ name: net.stops.name[s], lat: lat[s], lon: lon[s], stop: net.stops.id[s] });
  const coords = (nodes) => nodes.map((n) => [g.lat[n], g.lon[n]]);

  // ---------------------------------------------------------------- street legs

  // A point on the street graph: { node, meters } per mode, or null outside it.
  const pointSnap = (pt) => (g ? [snap(g, pt.lat, pt.lon, 'walk', LIMITS.snap), snap(g, pt.lat, pt.lon, 'bike', LIMITS.snap)] : [null, null]);
  const fromSnap = pointSnap(from), toSnap = pointSnap(to);

  // From the origin to the stops (layer = walking or cycling): Map stop → leg.
  function firstLegs(layer) {
    const legs = new Map();
    const sn = fromSnap[layer];
    if (sn) {
      const lead = flat(layer, sn.meters, 1);
      const search = streetSearch(g, { sources: [{ node: sn.node, t: lead.t, e: lead.e }], mode: MODE[layer], bike, optimize, maxTime: MAX_TRIP_S, slot: 0 });
      for (let s = 0; s < S; s++) {
        const hit = cheapestLink(search, layer, s);
        if (!hit) continue;
        const { n, t, e } = hit;
        legs.set(s, { t, e, path: () => [[from.lat, from.lon], ...coords(pathNodes(search, n).reverse()), [lat[s], lon[s]]] });
      }
    } else {
      for (let s = 0; s < S; s++) {
        const c = flat(layer, meters(from.lat, from.lon, lat[s], lon[s]));
        if (c.t <= MAX_TRIP_S) legs.set(s, { t: c.t, e: c.e, path: () => [[from.lat, from.lon], [lat[s], lon[s]]] });
      }
    }
    return legs;
  }

  // From the stops to the destination: Map node → leg. Searched backwards from it.
  function lastLegs(layer, slot) {
    const legs = new Map();
    const sn = toSnap[layer];
    if (sn) {
      const lead = flat(layer, sn.meters, 1);
      const search = streetSearch(g, { sources: [{ node: sn.node, t: lead.t, e: lead.e }], mode: MODE[layer], bike, optimize, maxTime: MAX_TRIP_S, reverse: true, slot });
      for (let s = 0; s < S; s++) {
        const hit = cheapestLink(search, layer, s);
        if (!hit) continue;
        const { n, t, e } = hit;
        legs.set(s * 2 + layer, { t, e, path: () => [[lat[s], lon[s]], ...coords(pathNodes(search, n)), [to.lat, to.lon]] });
      }
    } else {
      for (let s = 0; s < S; s++) {
        const c = flat(layer, meters(to.lat, to.lon, lat[s], lon[s]));
        if (c.t <= MAX_TRIP_S) legs.set(s * 2 + layer, { t: c.t, e: c.e, path: () => [[lat[s], lon[s]], [to.lat, to.lon]] });
      }
    }
    return legs;
  }

  // The best of the street nodes linked to stop s, by the search's own measure.
  function cheapestLink(search, layer, s) {
    const links = net.stopLinks[layer];
    let best = null;
    for (let k = links.ptr?.[s] ?? 0; k < (links.ptr?.[s + 1] ?? 0); k++) {
      const n = links.to[k];
      if (search.cost[n] === Infinity || !(search.time[n] <= MAX_TRIP_S)) continue;
      const link = flat(layer, links.dist[k], 1);
      const t = search.time[n] + link.t, e = search.energy[n] + link.e;
      const score = optimize === 'energy' ? e : t;
      if (!best || score < best.score) best = { n, t, e, score };
    }
    return best;
  }

  // Leg paths are read from the search buffers (slots 0–3) when a journey is rebuilt,
  // before this function returns: the next query reuses them.

  // ---------------------------------------------------------------- labels

  const best = new Array(S * 2);          // Pareto labels per node, all rounds
  const target = [];                      // Pareto options at the destination
  let cap = day.now + MAX_TRIP_S;         // latest arrival worth keeping
  const rounds = [];                      // per round: Map node → labels added
  let marked = new Set();

  const addTarget = (label) => {
    // The direct walk or ride is always an answer, however long.
    if ((label.t > cap && label.kind !== DIRECT) || covered(target, label.t, label.e)) return;
    insert(target, label);
    if (optimize === 'time') cap = Math.min(cap, slowest(Math.min(...target.map((l) => l.t)), day.now));
  };

  const add = (k, node, label) => {
    if (label.t > cap || covered(target, label.t, label.e) || covered(best[node], label.t, label.e)) return false;
    label.node = node;
    insert((best[node] ??= []), label);
    const bag = rounds[k];
    if (!bag.has(node)) bag.set(node, []);
    bag.get(node).push(label);
    marked.add(node);
    return true;
  };

  // Direct walk or ride, without transit.
  {
    const layer = prof.access;
    const a = fromSnap[layer], b = toSnap[layer];
    let direct = null;
    if (a && b) {
      const lead = flat(layer, a.meters, 1), tail = flat(layer, b.meters, 1);
      const search = streetSearch(g, { sources: [{ node: a.node, t: lead.t, e: lead.e }], mode: MODE[layer], bike, optimize, target: b.node, slot: 2 });
      if (search.cost[b.node] < Infinity) {
        const nodes = pathNodes(search, b.node).reverse();
        direct = { t: search.time[b.node] + tail.t, e: search.energy[b.node] + tail.e, path: [[from.lat, from.lon], ...coords(nodes), [to.lat, to.lon]] };
      }
    }
    if (!direct) {
      const d = meters(from.lat, from.lon, to.lat, to.lon);
      const c = flat(layer, d);
      direct = { ...c, path: [[from.lat, from.lon], [to.lat, to.lon]] };
    }
    addTarget({ kind: DIRECT, layer, t: day.now + direct.t, e: direct.e, path: direct.path });
  }

  const egress = new Map();
  prof.egress.forEach((layer) => { for (const [node, leg] of lastLegs(layer, layer ? 3 : 1)) egress.set(node, leg); });

  // Round 0: walk or ride from the origin to nearby stops.
  rounds.push(new Map());
  for (const [s, leg] of firstLegs(prof.access)) {
    add(0, s * 2 + prof.access, { kind: ACCESS, t: day.now + leg.t, e: leg.e, leg });
  }
  parkBikes(0);

  const providers = new Map();
  const providerFor = (pi, layer) => {
    const key = pi * 2 + layer;
    if (!providers.has(key)) providers.set(key, provider(net, day, live, pi, layer));
    return providers.get(key);
  };

  // Leaves the bike at a bicicletário next to stops reached in round k.
  function parkBikes(k) {
    if (!prof.park) return;
    for (const [node, labels] of [...rounds[k]]) {
      if ((node & 1) === 0) continue;
      const lot = net.parkingAt[node >> 1];
      if (lot < 0) continue;
      const open = day.lotOpen[lot];
      for (const l of [...labels]) {
        if (open && !inMask(open, l.t)) continue;
        add(k, node - 1, { kind: PARK, prev: l, lot, t: l.t + PARK_S, e: l.e + PASSIVE_W * PARK_S });
      }
    }
  }

  for (let k = 1; k <= MAX_ROUNDS && marked.size; k++) {
    const prevBag = rounds[k - 1];
    rounds.push(new Map());
    // Patterns to scan, each from its earliest marked stop.
    const queue = new Map();
    for (const node of marked) {
      const s = node >> 1, layer = node & 1;
      for (let e = net.stopPatterns.ptr[s]; e < net.stopPatterns.ptr[s + 1]; e++) {
        const key = net.stopPatterns.to[e] * 2 + layer, idx = net.stopPatterns.dist[e];
        if (!(queue.get(key) <= idx)) queue.set(key, idx);
      }
    }
    marked = new Set();

    const ready = k > 1 ? CHANGE_S : 0;
    for (const [key, startIdx] of queue) {
      const pi = key >> 1, layer = key & 1;
      const trips = providerFor(pi, layer);
      if (!trips) continue;
      const p = net.patterns[pi];
      const boardJ = BOARD_J[p.mode === 'bus' ? 'bus' : 'rail'][layer];
      let onboard = []; // { h, from: label, b: boarding index, e: energy on boarding }
      for (let i = startIdx; i < p.stops.length; i++) {
        const node = p.stops[i] * 2 + layer;
        for (const r of onboard) {
          const t = trips.time(r.h, i);
          if (t >= INF) continue;
          add(k, node, { kind: RIDE, prev: r.from, pi, layer, h: r.h, b: r.b, a: i, t, e: r.e + PASSIVE_W * (t - r.t) });
        }
        const here = prevBag.get(node);
        if (!here) continue;
        for (const l of here) {
          const h = trips.earliest(i, l.t + ready);
          if (h < 0) continue;
          const t = trips.time(h, i), e = l.e + PASSIVE_W * (t - l.t) + boardJ;
          // Energies compared here, at stop i; on board they grow at the same rate.
          const at = (r) => r.e + PASSIVE_W * (trips.time(r.h, i) - r.t);
          if (onboard.some((r) => trips.time(r.h, i) <= t && at(r) <= e)) continue;
          onboard = onboard.filter((r) => !(t <= trips.time(r.h, i) && e <= at(r)));
          onboard.push({ h, from: l, b: i, t, e });
        }
      }
    }

    // Walk (or ride) to nearby stops, then maybe park the bike.
    for (const [node, labels] of [...rounds[k]]) {
      const layer = node & 1, s = node >> 1;
      const tr = layer ? net.bikeTransfers : net.walkTransfers;
      for (const l of [...labels]) {
        if (l.kind !== RIDE) continue;
        for (let e = tr.ptr[s]; e < tr.ptr[s + 1]; e++) {
          const c = flat(layer, tr.dist[e]);
          add(k, tr.to[e] * 2 + layer, { kind: TRANSFER, prev: l, meters: Math.round(tr.dist[e] * DETOUR), t: l.t + c.t, e: l.e + c.e });
        }
      }
    }
    parkBikes(k);

    for (const [node, labels] of rounds[k]) {
      const leg = egress.get(node);
      if (!leg) continue;
      for (const l of labels) addTarget({ kind: EGRESS, prev: l, node, leg, t: l.t + leg.t, e: l.e + leg.e });
    }
  }

  const order = optimize === 'energy' ? (a, b) => a.e - b.e || a.t - b.t : (a, b) => a.t - b.t || a.e - b.e;
  return target.filter((l) => l.t <= cap || l.kind === DIRECT).sort(order).slice(0, MAX_JOURNEYS).map(rebuild);

  function rebuild(label) {
    const legs = [];
    const kcal = (j) => j / 4184;
    if (label.kind === DIRECT) {
      legs.push({ kind: MODE[label.layer], from: fromPt, to: toPt, depart: day.now, arrive: label.t, kcal: kcal(label.e), path: label.path, meters: pathMeters(label.path) });
      return { profile, depart: day.now, arrive: label.t, energy: label.e, kcal: kcal(label.e), rides: 0, legs };
    }
    let rides = 0;
    const s0 = label.node >> 1, layer0 = label.node & 1;
    const lastPath = label.leg.path();
    legs.push({ kind: MODE[layer0], from: stopPt(s0), to: toPt, depart: label.prev.t, arrive: label.t, kcal: kcal(label.leg.e), path: lastPath, meters: pathMeters(lastPath) });
    for (let l = label.prev; l; l = l.prev) {
      const before = l.prev;
      if (l.kind === ACCESS) {
        const path = l.leg.path();
        legs.push({ kind: MODE[prof.access], from: fromPt, to: stopPt(l.node >> 1), depart: day.now, arrive: l.t, kcal: kcal(l.e), path, meters: pathMeters(path) });
      } else if (l.kind === RIDE) {
        const p = net.patterns[l.pi], trips = providerFor(l.pi, l.layer);
        legs.push({
          kind: 'ride', mode: p.mode, route: p.route, rail: p.rail, headsign: p.headsign, withBike: l.layer === 1,
          from: stopPt(p.stops[l.b]), to: stopPt(p.stops[l.a]), depart: trips.time(l.h, l.b), arrive: l.t,
          stops: l.a - l.b, kcal: kcal(l.e - before.e), ...trips.info(l.h),
          path: Array.from(p.stops.subarray(l.b, l.a + 1), (x) => [lat[x], lon[x]]),
        });
        rides++;
      } else if (l.kind === TRANSFER) {
        const a = before.node >> 1, b = l.node >> 1;
        legs.push({ kind: MODE[l.node & 1], from: stopPt(a), to: stopPt(b), depart: before.t, arrive: l.t, meters: l.meters, kcal: kcal(l.e - before.e), path: [[lat[a], lon[a]], [lat[b], lon[b]]] });
      } else if (l.kind === PARK) {
        const lot = net.lots[l.lot];
        legs.push({ kind: 'park', at: { name: lot.name, lat: lot.lat, lon: lot.lon, access: lot.access }, to: stopPt(l.node >> 1), depart: before.t, arrive: l.t, kcal: kcal(l.e - before.e) });
      }
    }
    legs.reverse();
    // A transfer next to the first or last leg is the same walk or ride.
    const merged = [];
    for (const leg of legs) {
      const last = merged.at(-1);
      if (last && (leg.kind === 'walk' || leg.kind === 'bike') && last.kind === leg.kind) {
        merged[merged.length - 1] = { ...last, to: leg.to, arrive: leg.arrive, meters: last.meters + leg.meters, kcal: last.kcal + leg.kcal, path: [...last.path, ...leg.path] };
      } else merged.push(leg);
    }
    return { profile, depart: day.now, arrive: label.t, energy: label.e, kcal: kcal(label.e), rides, legs: merged };
  }

  function pathMeters(path) {
    let m = 0;
    for (let i = 1; i < path.length; i++) m += meters(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    return Math.round(m);
  }
}
