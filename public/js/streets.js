// Street graph for the trip planner (data/routing/streets.bin, built by scripts/streets.mjs):
// walking and cycling legs along real streets, with slopes.
//
// Cost model, per edge:
//   - Bike speed: amora's power model (Pedal Hidrográfico, app.js segmentSpeed): the
//     rider holds the chosen power on the flat, twice that on climbs over 2%, a fifth
//     of it downhill, letting 17% of the gravity assist become speed. Never slower
//     than pushing the bike, never faster than 35 km/h.
//   - Bike energy: amora's v2 leg energy (graph-engine.js stepCost) over a 25% muscle
//     efficiency.
//   - Walking: Tobler's hiking function, scaled to 4.5 km/h on the flat; energy from
//     Minetti et al. (2002), net of resting.
//   - Bikes ride the wrong way up one-way streets only where contraflow is allowed,
//     and are pushed (walking pace) on footways, pedestrian streets and steps.
// Energies are net metabolic joules (above resting); times are seconds.

export const RIDER = { body: 65, mass: 75, crr: 0.008, cda: 0.5, rho: 1.1, kEff: 0.97 };
const G = 9.81;
const MUSCLE_EFFICIENCY = 0.25;
export const WALK_MPS = 1.25;
const PUSH_FACTOR = 0.85;      // pushing a bike vs walking
const STEPS_MPS = 0.5;
const MAX_BIKE_MPS = 35 / 3.6;
const CLIMB_THRESHOLD = 0.02;
// Sitting or standing on a bus or train, or waiting: 1.3 MET, so 0.3 MET above resting.
export const PASSIVE_W = 0.3 * 1.163 * RIDER.body;

// Bike comfort by road class (cycleway, local, tertiary, secondary, primary, trunk,
// foot, steps): the search prefers calmer streets at this exchange rate.
const BIKE_COMFORT = [0.8, 1, 1.1, 1.25, 1.5, 2, 1, 1];
const LANE_COMFORT = 0.85;
// "Evitar avenidas": secondary, primary and trunk roads without a bike lane or track
// count this many times more, so they're used only where there's no other way.
const ARTERIAL_PENALTY = 5;
const FLAG = { oneway: 8, noBike: 16, noWalk: 32, infra: 64, push: 128 };

// ------------------------------------------------------------------ decode

export function decodeStreets(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x47534242 || dv.getUint32(4, true) !== 1) throw new Error('streets.bin: unknown format');
  const N = dv.getUint32(8, true), E = dv.getUint32(12, true);
  let off = 16;
  const section = (Ctor, n) => { const a = new Ctor(buf, off, n); off = (off + n * Ctor.BYTES_PER_ELEMENT + 3) & ~3; return a; };
  const latU = section(Int32Array, N), lonU = section(Int32Array, N), elevDm = section(Int16Array, N);
  const u = section(Uint32Array, E), v = section(Uint32Array, E), lenDm = section(Uint16Array, E), flags = section(Uint8Array, E);

  const lat = new Float64Array(N), lon = new Float64Array(N), elev = new Float32Array(N);
  for (let i = 0; i < N; i++) { lat[i] = latU[i] / 1e6; lon[i] = lonU[i] / 1e6; elev[i] = elevDm[i] / 10; }

  // Half-edges: 2e = u → v, 2e + 1 = v → u.
  const ptr = new Uint32Array(N + 1);
  for (let e = 0; e < E; e++) { ptr[u[e] + 1]++; ptr[v[e] + 1]++; }
  for (let i = 0; i < N; i++) ptr[i + 1] += ptr[i];
  const to = new Uint32Array(2 * E), half = new Uint32Array(2 * E);
  const cur = ptr.slice(0, N);
  const usable = new Uint8Array(N); // bit 0 walk, bit 1 bike
  for (let e = 0; e < E; e++) {
    let k = cur[u[e]]++; to[k] = v[e]; half[k] = 2 * e;
    k = cur[v[e]]++; to[k] = u[e]; half[k] = 2 * e + 1;
    const m = (flags[e] & FLAG.noWalk ? 0 : 1) | (flags[e] & FLAG.noBike ? 0 : 2);
    usable[u[e]] |= m; usable[v[e]] |= m;
  }

  // Node grid (~200 m cells) for snapping points to the network.
  const CELL = 0.002;
  const cellKey = (la, lo) => (Math.floor(la / CELL) + 50_000) * 100_000 + (Math.floor(lo / CELL) + 50_000);
  const keys = new Float64Array(N);
  for (let i = 0; i < N; i++) keys[i] = cellKey(lat[i], lon[i]);
  const byCell = new Uint32Array(N).map((_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const sortedKeys = Float64Array.from(byCell, (i) => keys[i]);

  return {
    N, E, lat, lon, elev, u, v, len: Float32Array.from(lenDm, (x) => x / 10), flags,
    ptr, to, half, usable, CELL, cellKey, byCell, sortedKeys,
    pool: [],
  };
}

const KY = 110_574;
const KX = 111_320 * Math.cos((-23.55 * Math.PI) / 180);
const metersBetween = (la1, lo1, la2, lo2) => Math.hypot((la2 - la1) * KY, (lo2 - lo1) * KX);

/**
 * Up to `max` nodes usable by `mode` within `radius` m, nearest first, each at least
 * `spacing` m from the ones kept before: a station between the tracks gets a node on
 * each side instead of several on the same street.
 */
export function snapAround(g, lat, lon, mode, radius, max = 4, spacing = 40) {
  const bit = mode === 'bike' ? 2 : 1;
  const r = Math.ceil(radius / (g.CELL * KX));
  const lower = (k) => { let lo = 0, hi = g.sortedKeys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (g.sortedKeys[m] < k) lo = m + 1; else hi = m; } return lo; };
  const near = [];
  const c0 = g.cellKey(lat, lon);
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const k = c0 + dr * 100_000 + dc;
      for (let j = lower(k); j < g.sortedKeys.length && g.sortedKeys[j] === k; j++) {
        const n = g.byCell[j];
        if (!(g.usable[n] & bit)) continue;
        const d = metersBetween(lat, lon, g.lat[n], g.lon[n]);
        if (d <= radius) near.push({ node: n, meters: d });
      }
    }
  }
  near.sort((a, b) => a.meters - b.meters);
  const kept = [];
  for (const c of near) {
    if (kept.every((k) => metersBetween(g.lat[k.node], g.lon[k.node], g.lat[c.node], g.lon[c.node]) >= spacing)) kept.push(c);
    if (kept.length === max) break;
  }
  return kept;
}

/** Nearest node usable by `mode` ('walk' | 'bike') within `radius` m: { node, meters } or null. */
export function snap(g, lat, lon, mode, radius = 1000) {
  const bit = mode === 'bike' ? 2 : 1;
  const r = Math.ceil(radius / (g.CELL * KX));
  const lower = (k) => { let lo = 0, hi = g.sortedKeys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (g.sortedKeys[m] < k) lo = m + 1; else hi = m; } return lo; };
  let best = -1, bd = radius;
  const c0 = g.cellKey(lat, lon);
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const k = c0 + dr * 100_000 + dc;
      for (let j = lower(k); j < g.sortedKeys.length && g.sortedKeys[j] === k; j++) {
        const n = g.byCell[j];
        if (!(g.usable[n] & bit)) continue;
        const d = metersBetween(lat, lon, g.lat[n], g.lon[n]);
        if (d < bd) { bd = d; best = n; }
      }
    }
  }
  return best < 0 ? null : { node: best, meters: bd };
}

// ------------------------------------------------------------------ models

function solveSpeed(power, grade) {
  const a = 0.5 * RIDER.rho * RIDER.cda, b = RIDER.mass * G * (RIDER.crr + grade);
  let v = 5;
  for (let i = 0; i < 60; i++) {
    const dv = (a * v ** 3 + b * v - power) / (3 * a * v * v + b);
    v -= dv;
    if (v < 0.1) v = 0.1;
    if (Math.abs(dv) < 1e-7) break;
  }
  return Math.max(0.5, v);
}

/** Walking speed (m/s) on `grade`: Tobler, scaled to WALK_MPS on the flat. */
export function walkSpeed(grade) {
  return WALK_MPS * Math.exp(-3.5 * Math.abs(grade + 0.05)) / Math.exp(-3.5 * 0.05);
}

/** Net metabolic cost of walking (J per kg per m), Minetti et al. 2002. */
export function walkCost(grade) {
  const i = Math.max(-0.45, Math.min(0.45, grade));
  return Math.max(0.5, 280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5);
}

const GRADE_STEP = 0.0025, GRADE_MAX = 0.3, GRADE_BINS = Math.round((2 * GRADE_MAX) / GRADE_STEP) + 1;

/**
 * Speed and energy model of a rider at `power` W on the flat. `avoidArterials` steers
 * the route off busy roads without bike infrastructure (see ARTERIAL_PENALTY).
 */
export function bikeModel(power, { avoidArterials = false } = {}) {
  const vFlat = solveSpeed(power, 0);
  const speed = new Float64Array(GRADE_BINS);
  for (let b = 0; b < GRADE_BINS; b++) {
    const g = b * GRADE_STEP - GRADE_MAX;
    let v;
    if (g > CLIMB_THRESHOLD) v = solveSpeed(2 * power, g);
    else if (g >= -CLIMB_THRESHOLD) v = solveSpeed(power, g);
    else v = Math.max(vFlat, vFlat + 0.17 * (solveSpeed(0.2 * power, g) - vFlat));
    speed[b] = Math.min(MAX_BIKE_MPS, Math.max(walkSpeed(g) * PUSH_FACTOR, v));
  }
  // amora's v2 cost bundle (readCost) for this flat speed.
  const aero = 0.5 * RIDER.rho * RIDER.cda * vFlat * vFlat;
  const cost = {
    aRoll: (RIDER.crr * RIDER.mass * G) / RIDER.kEff,
    aAero: aero / RIDER.kEff,
    beta: (RIDER.mass * G) / RIDER.kEff,
    abRatio: RIDER.crr + aero / (RIDER.mass * G),
  };
  return { power, vFlat, speed, cost, avoidArterials };
}

/** amora's v2 leg energy (J) for `d` m with height change `dh` m. */
function legEnergy(d, dh, c) {
  if (dh >= 0) return c.aRoll * d + (dh < CLIMB_THRESHOLD * d ? c.aAero * d : 0) + c.beta * dh;
  const ndh = -dh;
  const eps = Math.max(0, Math.min(1, (c.abRatio * d) / ndh) - 0.13);
  return Math.max(0, c.aRoll * d + c.aAero * d - eps * c.beta * ndh);
}

/**
 * Time (s) and energy (J) to go `d` m with height change `dh` on an edge with `flags`,
 * by 'walk' or by 'bike' (riding, or pushing where riding isn't allowed).
 */
export function edgeCost(mode, d, dh, flags, bike) {
  const grade = d > 0 ? dh / d : 0;
  const cls = flags & 7;
  if (mode === 'walk' || flags & FLAG.push || cls === 7) {
    const pushing = mode === 'bike';
    const mass = pushing ? RIDER.mass : RIDER.body;
    const v = cls === 7 ? STEPS_MPS : walkSpeed(grade) * (pushing ? PUSH_FACTOR : 1);
    const t = d / v;
    return { t, e: walkCost(grade) * mass * d, comfort: 1 };
  }
  const b = Math.max(0, Math.min(GRADE_BINS - 1, Math.round((grade + GRADE_MAX) / GRADE_STEP)));
  const t = d / bike.speed[b];
  const e = Math.max(PASSIVE_W * t, legEnergy(d, dh, bike.cost) / MUSCLE_EFFICIENCY);
  let comfort = flags & FLAG.infra ? Math.min(LANE_COMFORT, BIKE_COMFORT[cls]) : BIKE_COMFORT[cls];
  if (bike.avoidArterials && cls >= 3 && cls <= 5 && !(flags & FLAG.infra)) comfort *= ARTERIAL_PENALTY;
  return { t, e, comfort };
}

/**
 * A leg on flat ground, `detour` × the straight-line distance: the fallback without the
 * street graph, and short links and transfers. Mode 'push' is walking with the bike,
 * as inside stations, where riding isn't allowed.
 */
export function flatLeg(mode, meters, bike, detour = 1.3) {
  const d = meters * detour;
  if (mode === 'walk') return { t: d / WALK_MPS, e: walkCost(0) * RIDER.body * d };
  if (mode === 'push') return { t: d / (WALK_MPS * PUSH_FACTOR), e: walkCost(0) * RIDER.mass * d };
  const t = d / bike.speed[Math.round(GRADE_MAX / GRADE_STEP)];
  return { t, e: Math.max(PASSIVE_W * t, legEnergy(d, 0, bike.cost) / MUSCLE_EFFICIENCY) };
}

/**
 * Moving through a station (street ↔ platform, or a corridor between lines) for `t`
 * seconds, climbing `up` metres. On foot the escalators do the climbing: about half
 * of walking effort. With the bike there are no escalators: walk it, and carry rider
 * and bike up the stairs.
 */
export function stationLeg(withBike, t, up = 0) {
  if (!withBike) return { t, e: 0.5 * walkCost(0) * RIDER.body * WALK_MPS * t };
  const pushing = walkCost(0) * RIDER.mass * WALK_MPS * PUSH_FACTOR * t;
  return { t, e: pushing + (RIDER.mass * G * up) / MUSCLE_EFFICIENCY };
}

// ------------------------------------------------------------------ search

class Heap {
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  /** Removes the minimum; its key is left in `this.key`. */
  pop() {
    const K = this.k, V = this.v, top = V[0];
    this.key = K[0];
    const key = K[--this.n], val = V[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && K[c + 1] < K[c]) c++;
      if (K[c] >= key) break;
      K[i] = K[c]; V[i] = V[c]; i = c;
    }
    K[i] = key; V[i] = val;
    return top;
  }
}

/** Search buffers sized to the graph, reused between queries. */
function buffers(g, slot) {
  if (!g.pool[slot]) {
    g.pool[slot] = {
      cost: new Float32Array(g.N).fill(Infinity), time: new Float32Array(g.N), energy: new Float32Array(g.N),
      parent: new Int32Array(g.N).fill(-1), touched: [],
    };
  }
  const s = g.pool[slot];
  for (const n of s.touched) { s.cost[n] = Infinity; s.parent[n] = -1; }
  s.touched = [];
  return s;
}

/**
 * Dijkstra from `sources` ([{ node, t, e }]) by 'walk' or 'bike', minimising time
 * (times comfort, for bikes) or energy. Stops past `maxTime` seconds or once `target`
 * is settled. `reverse` searches towards the sources (for the last leg of a trip).
 * `slot` picks the reusable buffers (0–2). Returns the buffers: time, energy and
 * parent of every reached node (`touched`).
 */
export function streetSearch(g, { sources, mode, bike, optimize = 'time', maxTime = Infinity, reverse = false, target = -1, slot = 0 }) {
  const s = buffers(g, slot);
  const heap = new Heap();
  for (const src of sources) {
    const c = optimize === 'energy' ? src.e : src.t;
    if (c < s.cost[src.node]) {
      if (s.cost[src.node] === Infinity) s.touched.push(src.node);
      s.cost[src.node] = c; s.time[src.node] = src.t; s.energy[src.node] = src.e; s.parent[src.node] = -1;
      heap.push(s.cost[src.node], src.node); // as stored (32-bit), for the stale check
    }
  }
  while (heap.n) {
    const x = heap.pop();
    if (heap.key > s.cost[x]) continue; // stale entry
    if (x === target) break;
    const tx = s.time[x];
    if (tx > maxTime) continue;
    for (let k = g.ptr[x]; k < g.ptr[x + 1]; k++) {
      const h = g.half[k], e = h >> 1, y = g.to[k];
      const flags = g.flags[e];
      if (!(mode === 'bike' ? !(flags & FLAG.noBike) : !(flags & FLAG.noWalk))) continue;
      // Direction actually travelled: x → y, or y → x when searching backwards.
      const forward = reverse ? (h & 1) === 1 : (h & 1) === 0;
      const riding = mode === 'bike' && !(flags & FLAG.push) && (flags & 7) !== 7;
      if (riding && flags & FLAG.oneway && !forward) continue;
      const dh = reverse ? g.elev[x] - g.elev[y] : g.elev[y] - g.elev[x];
      const c = edgeCost(mode, g.len[e], dh, flags, bike);
      const t = tx + c.t, en = s.energy[x] + c.e;
      const cost = s.cost[x] + (optimize === 'energy' ? c.e * c.comfort : c.t * c.comfort);
      if (cost < s.cost[y]) {
        if (s.cost[y] === Infinity) s.touched.push(y);
        s.cost[y] = cost; s.time[y] = t; s.energy[y] = en; s.parent[y] = x;
        heap.push(s.cost[y], y);
      }
    }
  }
  return s;
}

/** Nodes from the search source to `node` (or from `node` to the source, if reverse). */
export function pathNodes(s, node) {
  const out = [];
  for (let n = node, guard = 0; n >= 0 && guard < 1e6; n = s.parent[n], guard++) out.push(n);
  return out;
}
