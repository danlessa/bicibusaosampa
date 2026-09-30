// Picks the bike-carrying buses out of an Olho Vivo /Posicao snapshot.
// Kept free of the JSON config import so Node tests can load it directly.

export function vehicleFilter(config) {
  const lines = new Set(config.lines.map((l) => l.code));
  const prefixes = new Set(config.vehicles.map(String));

  return function selectVehicles(snapshot) {
    const vehicles = [];
    for (const line of snapshot.l ?? []) {
      const listed = lines.has(line.c);
      for (const v of line.vs ?? []) {
        if (!listed && !prefixes.has(String(v.p))) continue;
        vehicles.push({
          prefix: String(v.p),
          line: line.c,
          sentido: line.sl,
          // lt0/lt1 are the line's destination/origin signs in sentido 1.
          to: line.sl === 1 ? line.lt0 : line.lt1,
          from: line.sl === 1 ? line.lt1 : line.lt0,
          lat: v.py,
          lon: v.px,
          at: v.ta,
          accessible: v.a === true,
        });
      }
    }
    return vehicles;
  };
}
