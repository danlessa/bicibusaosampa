// Direction of travel of a bus, which the Olho Vivo API doesn't report.
//
// Angles are in degrees, math convention: 0 = east, 90 = north, counter-clockwise.

const METERS_PER_DEGREE = 111_320;

/** Planar offset in metres from `a` to `b` ([lat, lon] pairs). */
function offset(a, b) {
  const k = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  return [(b[1] - a[1]) * k * METERS_PER_DEGREE, (b[0] - a[0]) * METERS_PER_DEGREE];
}

const angleOf = ([dx, dy]) => Math.atan2(dy, dx) * (180 / Math.PI);

/**
 * Direction of the route segment of `route` ([[lat, lon], ...], in travel order)
 * nearest to `point`, and how far the point is from it (metres).
 */
export function headingOnRoute(point, route) {
  let best = null;
  for (let i = 1; i < route.length; i++) {
    const seg = offset(route[i - 1], route[i]);
    const p = offset(route[i - 1], point);
    const len2 = seg[0] ** 2 + seg[1] ** 2;
    if (!len2) continue;
    const t = Math.max(0, Math.min(1, (p[0] * seg[0] + p[1] * seg[1]) / len2));
    const distance = Math.hypot(p[0] - t * seg[0], p[1] - t * seg[1]);
    if (!best || distance < best.distance) best = { angle: angleOf(seg), distance };
  }
  return best;
}

/** Direction of the move from `from` to `to`, or null if it moved less than `minMeters`. */
export function headingOfMove(from, to, minMeters = 15) {
  const d = offset(from, to);
  return Math.hypot(d[0], d[1]) < minMeters ? null : angleOf(d);
}

/**
 * CSS transform that points a right-facing side-view icon along `angle`.
 * Westbound icons are mirrored instead of turned upside down.
 */
export function iconTransform(angle) {
  if (angle == null) return '';
  const a = ((angle % 360) + 540) % 360 - 180; // (-180, 180]
  if (Math.abs(a) <= 90) return `rotate(${(-a).toFixed(1)}deg)`;
  const tilt = a > 0 ? a - 180 : a + 180; // angle relative to due west
  return `rotate(${(-tilt).toFixed(1)}deg) scaleX(-1)`;
}
