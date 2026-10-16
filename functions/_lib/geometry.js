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

/** Decodes a Google encoded polyline (precision 5) into [lon, lat] points. */
export function decodePolyline(text) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, result = 0, c;
    do {
      c = text.charCodeAt(i++) - 63;
      result |= (c & 31) << shift;
      shift += 5;
    } while (c >= 32);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    pts.push([lon / 1e5, lat / 1e5]);
  }
  return pts;
}
