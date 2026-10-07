// Polylines drawn a number of pixels to the side of their true path, so routes
// sharing a street show side by side. Positive offsets go to the right of the
// direction of travel. `offset` is a number, or a function of the map zoom. Approximate on purpose: each vertex moves along the
// average normal of its two segments.

export function offsetPolylineClass(L) {
  return L.Polyline.extend({
    _project() {
      L.Polyline.prototype._project.call(this);
      const { offset } = this.options;
      const d = typeof offset === 'function' ? offset(this._map.getZoom()) : offset;
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
