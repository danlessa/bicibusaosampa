// Polylines drawn a fixed number of pixels to the side of their true path, so
// routes sharing a street show side by side. Positive offsets go to the right of
// the direction of travel. Approximate on purpose: each vertex moves along the
// average normal of its two segments.

export function offsetPolylineClass(L) {
  return L.Polyline.extend({
    _project() {
      L.Polyline.prototype._project.call(this);
      const d = this.options.offset;
      if (d) this._rings = this._rings.map((ring) => offsetRing(ring, d, L));
    },
  });
}

function offsetRing(points, d, L) {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) return p;
    // Screen y grows downwards, so (-dy, dx) is the right-hand side.
    return L.point(p.x - (dy / len) * d, p.y + (dx / len) * d);
  });
}

/**
 * Assigns a lane (0, 1, 2, …) to each line so that lines sharing streets get
 * different lanes. `shapes` maps line code to a list of [[lat, lon], ...] routes;
 * `distance(point, route)` returns metres from a point to a route.
 */
export function assignLanes(shapes, distance, { nearMeters = 30, minShared = 0.1 } = {}) {
  const codes = Object.keys(shapes);
  const shares = (a, b) => {
    const pts = shapes[a].flat().filter((_, i) => i % 3 === 0); // a sample is plenty
    const near = pts.filter((p) => shapes[b].some((route) => distance(p, route) < nearMeters)).length;
    return pts.length && near / pts.length >= minShared;
  };
  const lanes = {};
  for (const code of codes) {
    const taken = new Set(codes.filter((c) => c in lanes && (shares(code, c) || shares(c, code))).map((c) => lanes[c]));
    let lane = 0;
    while (taken.has(lane)) lane++;
    lanes[code] = lane;
  }
  return lanes;
}
