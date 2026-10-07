// Geometry helpers shared by the data build script and the /api/route function.

/** Rounds a coordinate to 5 decimals (~1 m). */
export const round = (x) => Math.round(x * 1e5) / 1e5;

// ~2 m: invisible on the map, roughly halves file sizes.
export const SIMPLIFY_TOLERANCE = 0.00002;

/** Douglas–Peucker simplification of [lon, lat] points. */
export function simplify(pts, tol = SIMPLIFY_TOLERANCE) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || Number.EPSILON;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
