// Assigns each bus line a lane (0 … maxLanes-1) so lines sharing streets are drawn
// side by side. Lines are rasterised onto a ~50 m grid; two lines "share" when at
// least `minShared` of either one's cells overlap the other. Greedy colouring,
// busiest lines first; when every lane is taken, the least-conflicting one is reused.

const CELL = 0.0005; // degrees, ~50 m

function cells(routes) {
  const set = new Set();
  for (const route of routes) {
    for (let i = 1; i < route.length; i++) {
      const [x0, y0] = route[i - 1], [x1, y1] = route[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2)));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps, y = y0 + ((y1 - y0) * s) / steps;
        set.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
      }
    }
  }
  return set;
}

/** `routes` maps line code to a list of [[lon, lat], ...] routes. */
export function assignLanes(routes, { minShared = 0.1, maxLanes = 4 } = {}) {
  const grid = Object.fromEntries(Object.entries(routes).map(([code, r]) => [code, cells(r)]));
  const codes = Object.keys(grid).sort((a, b) => grid[b].size - grid[a].size || a.localeCompare(b));
  const overlap = (a, b) => {
    let n = 0;
    for (const c of grid[a]) if (grid[b].has(c)) n++;
    return n;
  };
  const conflicts = (a, b) => {
    const n = overlap(a, b);
    return n && (n / grid[a].size >= minShared || n / grid[b].size >= minShared) ? n : 0;
  };

  const lanes = {};
  for (const code of codes) {
    const cost = new Array(maxLanes).fill(0);
    for (const other of Object.keys(lanes)) cost[lanes[other]] += conflicts(code, other);
    lanes[code] = cost.indexOf(Math.min(...cost));
  }
  return lanes;
}
