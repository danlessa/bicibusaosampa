// A Leaflet canvas renderer that can stroke polylines with a hatch pattern:
// the line's colour crossed by diagonal stripes of a second colour.
// Use it with `L.polyline(latlngs, { renderer, hatch: { base, stripe } })`.

const TILE = 12; // pattern period in pixels
const STRIPE = 4; // stripe width in pixels

function makePattern(ctx, base, stripe) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = TILE;
  const g = tile.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, TILE, TILE);
  g.strokeStyle = stripe;
  g.lineWidth = STRIPE;
  g.beginPath();
  // Three parallel diagonals so the stripes join up across tile edges.
  for (const k of [-TILE, 0, TILE]) {
    g.moveTo(k, TILE);
    g.lineTo(k + TILE, 0);
  }
  g.stroke();
  return ctx.createPattern(tile, 'repeat');
}

export function hatchRenderer(L, options) {
  const patterns = new Map();
  const Hatch = L.Canvas.extend({
    _fillStroke(ctx, layer) {
      const hatch = layer.options.hatch;
      if (!hatch) return L.Canvas.prototype._fillStroke.call(this, ctx, layer);
      const key = `${hatch.base}|${hatch.stripe}`;
      if (!patterns.has(key)) patterns.set(key, makePattern(ctx, hatch.base, hatch.stripe));
      // Leaflet assigns options.color to strokeStyle, which also accepts a pattern.
      const color = layer.options.color;
      layer.options.color = patterns.get(key);
      L.Canvas.prototype._fillStroke.call(this, ctx, layer);
      layer.options.color = color;
    },
  });
  return new Hatch(options);
}
