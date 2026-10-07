// Live 23m buses as trips for the planner (raptor.js): each bus from /api/buses is
// placed on the line it is actually running, and its arrival at the stops ahead is
// projected with the GTFS stop-to-stop times of that line.

import { INF, KX_KY } from './raptor.js';

const MAX_OFF_ROUTE_M = 400;  // farther from its line than this, the bus is skipped
const MAX_AGE_S = 600;        // positions older than this are skipped

/** Where along `p` the point is: { i, f, d } = segment i → i+1, fraction f, distance d (m). */
export function locate(net, p, lat, lon) {
  const [kx, ky] = KX_KY;
  let best = { i: -1, f: 0, d: Infinity };
  for (let i = 0; i + 1 < p.stops.length; i++) {
    const a = p.stops[i], b = p.stops[i + 1];
    const ax = (net.stops.lon[a] - lon) * kx, ay = (net.stops.lat[a] - lat) * ky;
    const bx = (net.stops.lon[b] - lon) * kx, by = (net.stops.lat[b] - lat) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (d < best.d) best = { i, f, d };
  }
  return best;
}

/**
 * Map pattern index → [{ prefix, times }] for the vehicles of /api/buses.
 * `day` is raptor.js's queryDay(); times are seconds since its midnight, INF for stops
 * the bus has already passed.
 */
export function liveTrips(net, vehicles, day) {
  const out = new Map();
  for (const v of vehicles) {
    const at = (Date.parse(v.at) - day.dayStartMs) / 1000;
    if (!Number.isFinite(at) || day.now - at > MAX_AGE_S) continue;
    // Olho Vivo sentido 1/2 is GTFS direction 0/1.
    const candidates = net.byRouteDir.get(`${v.line}|${v.sentido - 1}`) ?? [];
    let pick = null;
    for (const pi of candidates) {
      if (!day.active[pi]) continue;
      const where = locate(net, net.patterns[pi], v.lat, v.lon);
      if (where.d <= MAX_OFF_ROUTE_M && (!pick || where.d < pick.where.d)) pick = { pi, where };
    }
    if (!pick) continue;
    const p = net.patterns[pick.pi], { i, f } = pick.where;
    const here = p.offsets[i] + f * (p.offsets[i + 1] - p.offsets[i]);
    const times = new Int32Array(p.stops.length).fill(INF);
    for (let j = i + 1; j < times.length; j++) times[j] = Math.round(at + p.offsets[j] - here);
    if (!out.has(pick.pi)) out.set(pick.pi, []);
    out.get(pick.pi).push({ prefix: v.prefix, times });
  }
  return out;
}
