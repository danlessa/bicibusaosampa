// Street graph for the trip planner: OpenStreetMap streets, paths and cycleways with
// what walking and cycling may do on each, and the elevation of every node, written
// to public/data/routing/streets.bin and read by public/js/streets.js.
//
// Elevations come from amora's baked graph (Pedal Hidrográfico, sampa-viario-graph.bin):
// the São Paulo DEM where it covers, FABDEM elsewhere, with amora's smoothing. Each
// node takes the elevation of the nearest amora node.
//
// Format (little-endian, sections padded to 4 bytes):
//   header  magic 'BBSG', u32 version = 1, u32 N (nodes), u32 E (edges)
//   lat     i32[N]  microdegrees
//   lon     i32[N]
//   elev    i16[N]  decimetres
//   u, v    u32[E]  end nodes; a one-way street for bikes runs u → v
//   len     u16[E]  decimetres
//   flags   u8[E]   bits 0–2 class (CLASS below), 3 bikes only u → v, 4 no bikes at all,
//                   5 no walking, 6 bike lane or track on the road, 7 bike must be pushed

export const CLASS = { cycleway: 0, local: 1, tertiary: 2, secondary: 3, primary: 4, trunk: 5, foot: 6, steps: 7 };
export const FLAG = { oneway: 8, noBike: 16, noWalk: 32, infra: 64, push: 128 };

const ROAD_CLASS = {
  cycleway: CLASS.cycleway,
  residential: CLASS.local, living_street: CLASS.local, service: CLASS.local, unclassified: CLASS.local,
  road: CLASS.local, track: CLASS.local,
  tertiary: CLASS.tertiary, tertiary_link: CLASS.tertiary,
  secondary: CLASS.secondary, secondary_link: CLASS.secondary,
  primary: CLASS.primary, primary_link: CLASS.primary,
  trunk: CLASS.trunk, trunk_link: CLASS.trunk, motorway: CLASS.trunk, motorway_link: CLASS.trunk,
  footway: CLASS.foot, pedestrian: CLASS.foot, path: CLASS.foot, corridor: CLASS.foot, bridleway: CLASS.foot,
  steps: CLASS.steps,
};
const YES = new Set(['yes', 'designated', 'permissive', 'official']);
const NO = new Set(['no', 'private', 'restricted']);
const LANE = /^(lane|track|opposite_lane|opposite_track|share_busway)$/;
const SIDES = ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right'];

/**
 * What a way allows, from its OSM tags: null when nothing in this graph may use it,
 * otherwise { flags, reverse } where reverse means the bike one-way runs against the
 * way's node order.
 */
export function wayAccess(tags) {
  const cls = ROAD_CLASS[tags.highway];
  if (cls === undefined) return null;
  const closed = NO.has(tags.access);
  const motor = tags.highway.startsWith('motorway');
  let walk = !motor && !NO.has(tags.foot) && (!closed || YES.has(tags.foot));
  if (tags.highway === 'cycleway' && !YES.has(tags.foot) && tags.foot !== undefined) walk = !NO.has(tags.foot);

  let bike = 'ride';
  if (cls === CLASS.trunk) bike = YES.has(tags.bicycle) ? 'ride' : 'no';
  else if (cls === CLASS.foot) bike = YES.has(tags.bicycle) ? 'ride' : 'push';
  else if (cls === CLASS.steps) bike = 'push';
  if (bike === 'ride' && (NO.has(tags.bicycle) || (closed && !YES.has(tags.bicycle)))) bike = 'push';
  if (bike === 'push' && !walk) bike = 'no';
  if (!walk && bike === 'no') return null;

  let flags = cls;
  if (!walk) flags |= FLAG.noWalk;
  if (bike === 'no') flags |= FLAG.noBike;
  if (bike === 'push') flags |= FLAG.push;
  const lane = SIDES.some((k) => LANE.test(tags[k] ?? ''));
  if (lane && cls !== CLASS.cycleway) flags |= FLAG.infra;
  if (YES.has(tags.bicycle) && cls === CLASS.foot) flags = (flags & ~7) | CLASS.cycleway;

  // One-way for bikes, unless contraflow is allowed.
  const ow = tags['oneway:bicycle'] ?? tags.oneway;
  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  const contraflow = tags['oneway:bicycle'] === 'no' || SIDES.some((k) => /^opposite/.test(tags[k] ?? ''));
  let reverse = false;
  if (bike === 'ride' && !contraflow) {
    if (ow === 'yes' || ow === '1' || ow === 'true' || (roundabout && ow !== 'no')) flags |= FLAG.oneway;
    else if (ow === '-1' || ow === 'reverse') { flags |= FLAG.oneway; reverse = true; }
  }
  return { flags, reverse };
}

// ------------------------------------------------------------------ geometry

const KY = 110_574;
const KX = 111_320 * Math.cos((-23.55 * Math.PI) / 180);
const dist = (a, b) => Math.hypot((b[0] - a[0]) * KY, (b[1] - a[1]) * KX);

/** Indices of the points kept by Douglas–Peucker at `tol` metres ([lat, lon] points). */
function simplifyIdx(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][1] * KX, ay = pts[a][0] * KY, bx = pts[b][1] * KX, by = pts[b][0] * KY;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (pts[i][1] * KX - ax) - dx * (pts[i][0] * KY - ay)) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

// ------------------------------------------------------------------ build

const SIMPLIFY_M = 5;     // shape points closer than this to the straight line are dropped
const MAX_EDGE_M = 150;   // longer stretches get extra nodes, so slopes aren't averaged away

/**
 * Builds the graph. `ways`: Map id → { nodes: [osm node ids], tags }; `coords`: Map osm
 * node id → [lat, lon]; `elevation(lat, lon)` → metres.
 */
export function buildStreets(ways, coords, elevation) {
  const usable = [];
  const uses = new Map();
  for (const w of ways.values()) {
    const access = wayAccess(w.tags);
    if (!access || w.nodes.length < 2 || !w.nodes.every((n) => coords.has(n))) continue;
    usable.push({ ...w, ...access });
    w.nodes.forEach((n, i) => uses.set(n, (uses.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  }

  const nodeOf = new Map(); // key → index
  const lat = [], lon = [];
  const node = (p, key) => {
    let i = nodeOf.get(key);
    if (i === undefined) { i = lat.length; nodeOf.set(key, i); lat.push(Math.round(p[0] * 1e6)); lon.push(Math.round(p[1] * 1e6)); }
    return i;
  };
  const edges = new Map(); // "u,v" → [u, v, len, flags]
  let synthetic = 0;

  for (const w of usable) {
    const ids = w.reverse ? [...w.nodes].reverse() : w.nodes;
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (i < ids.length - 1 && (uses.get(ids[i]) ?? 0) < 2) continue;
      const pts = ids.slice(start, i + 1).map((id) => coords.get(id));
      const keep = simplifyIdx(pts, SIMPLIFY_M);
      let prev = node(pts[0], ids[start]);
      for (let k = 1; k < keep.length; k++) {
        const a = pts[keep[k - 1]], b = pts[keep[k]];
        let len = 0;
        for (let j = keep[k - 1] + 1; j <= keep[k]; j++) len += dist(pts[j - 1], pts[j]);
        const pieces = Math.max(1, Math.ceil(len / MAX_EDGE_M));
        for (let s = 1; s <= pieces; s++) {
          const f = s / pieces;
          const cur = s === pieces
            ? node(b, ids[start + keep[k]])
            : node([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], `s${synthetic++}`);
          if (cur !== prev) {
            const key = prev < cur ? `${prev},${cur}` : `${cur},${prev}`;
            if (!edges.has(key)) edges.set(key, [prev, cur, len / pieces, w.flags]);
          }
          prev = cur;
        }
      }
      start = i;
    }
  }

  // Spatial order (Z-order of ~10 m cells) so nearby nodes sit close in memory.
  const N = lat.length;
  const morton = (x, y) => {
    let m = 0;
    for (let b = 0; b < 16; b++) m += ((x >> b) & 1) * 2 ** (2 * b) + ((y >> b) & 1) * 2 ** (2 * b + 1);
    return m;
  };
  let minLat = Infinity, minLon = Infinity;
  for (let i = 0; i < N; i++) { if (lat[i] < minLat) minLat = lat[i]; if (lon[i] < minLon) minLon = lon[i]; }
  const key = Float64Array.from(lat, (la, i) => morton(Math.min(65535, Math.floor((lon[i] - minLon) / 100)), Math.min(65535, Math.floor((la - minLat) / 100))));
  const order = new Uint32Array(N).map((_, i) => i).sort((a, b) => key[a] - key[b]);
  const rank = new Uint32Array(N);
  order.forEach((old, i) => { rank[old] = i; });

  const E = edges.size;
  const pad = (n) => (n + 3) & ~3;
  const size = 16 + 4 * N * 2 + pad(2 * N) + 4 * E * 2 + pad(2 * E) + pad(E);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x47534242, true); // 'BBSG'
  dv.setUint32(4, 1, true);
  dv.setUint32(8, N, true);
  dv.setUint32(12, E, true);
  let off = 16;
  const section = (Ctor, n) => { const a = new Ctor(buf, off, n); off = pad(off + n * Ctor.BYTES_PER_ELEMENT); return a; };
  const latA = section(Int32Array, N), lonA = section(Int32Array, N), elevA = section(Int16Array, N);
  const uA = section(Uint32Array, E), vA = section(Uint32Array, E), lenA = section(Uint16Array, E), flagA = section(Uint8Array, E);
  for (let i = 0; i < N; i++) {
    const r = rank[i];
    latA[r] = lat[i]; lonA[r] = lon[i];
    elevA[r] = Math.max(-32767, Math.min(32767, Math.round(elevation(lat[i] / 1e6, lon[i] / 1e6) * 10)));
  }
  let e = 0;
  for (const [u, v, len, flags] of edges.values()) {
    uA[e] = rank[u]; vA[e] = rank[v]; lenA[e] = Math.min(65535, Math.max(1, Math.round(len * 10))); flagA[e] = flags; e++;
  }
  return { buffer: buf, nodes: N, edges: E };
}

// ------------------------------------------------------------------ elevation

/**
 * Elevation lookup from amora's sampa-viario-graph.bin (format 'PHVG' v1, see amora's
 * scripts/build-viario.py): the nearest amora node within ~100 m, else 0.
 */
export function phvgElevation(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== 0x47564850 || dv.getUint32(4, true) !== 1) throw new Error('not a PHVG v1 graph');
  const N = dv.getUint32(8, true), NESC = dv.getUint32(12, true);
  let off = 24;
  const view = (Ctor, len) => { off = (off + 3) & ~3; const v = new Ctor(arrayBuffer, off, len); off += len * Ctor.BYTES_PER_ELEMENT; return v; };
  const dLat = view(Int16Array, N), dLng = view(Int16Array, N), elev = view(Int16Array, N);
  view(Uint8Array, N); view(Uint16Array, N);
  const escIdx = view(Uint32Array, NESC), escLat = view(Int32Array, NESC), escLng = view(Int32Array, NESC);

  const CELL = 300; // microdegrees, ~30 m
  const cellLat = new Int32Array(N), cellLon = new Int32Array(N), latU = new Int32Array(N), lonU = new Int32Array(N);
  let pLat = 0, pLng = 0, e = 0;
  for (let i = 0; i < N; i++) {
    if (dLat[i] === -32768) { pLat = escLat[e]; pLng = escLng[e]; e++; } else { pLat += dLat[i]; pLng += dLng[i]; }
    latU[i] = pLat; lonU[i] = pLng;
    cellLat[i] = Math.floor(pLat / CELL); cellLon[i] = Math.floor(pLng / CELL);
  }
  if (e !== NESC || escIdx.length !== NESC) throw new Error('PHVG escapes out of order');
  const ckey = (a, b) => (a + 1e6) * 1e7 + (b + 1e6);
  const order = new Uint32Array(N).map((_, i) => i).sort((a, b) => ckey(cellLat[a], cellLon[a]) - ckey(cellLat[b], cellLon[b]));
  const keys = Float64Array.from(order, (i) => ckey(cellLat[i], cellLon[i]));
  const lower = (k) => { let lo = 0, hi = keys.length; while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < k) lo = m + 1; else hi = m; } return lo; };

  return (lat, lon) => {
    const la = Math.round(lat * 1e6), lo = Math.round(lon * 1e6);
    const cl = Math.floor(la / CELL), cn = Math.floor(lo / CELL);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let a = cl - r; a <= cl + r; a++) {
        for (let b = cn - r; b <= cn + r; b++) {
          const k = ckey(a, b);
          for (let j = lower(k); j < keys.length && keys[j] === k; j++) {
            const i = order[j];
            const d = ((latU[i] - la) * KY) ** 2 + ((lonU[i] - lo) * KX) ** 2;
            if (d < bd) { bd = d; best = i; }
          }
        }
      }
    }
    return best < 0 ? 0 : elev[best] / 10;
  };
}
