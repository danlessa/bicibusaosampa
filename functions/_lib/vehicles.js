// Picks the bike-rack buses out of an Olho Vivo /Posicao snapshot.
// Kept free of JSON imports so Node tests can load it directly.

/**
 * `prefixes` lists the buses with a bike rack (data/bike-fleet.json);
 * `config` is public/data/bike-buses.json, whose `lines` are the expected lines.
 */
export function vehicleFilter(config, prefixes) {
  const expected = new Set(config.lines.map((l) => l.code));
  const fleet = new Set(prefixes.map(String));

  return function selectVehicles(snapshot) {
    const vehicles = [];
    for (const line of snapshot.l ?? []) {
      for (const v of line.vs ?? []) {
        const prefix = String(v.p);
        if (!fleet.has(prefix)) continue;
        vehicles.push({
          prefix,
          line: line.c,
          // False when the bus is running a line it doesn't usually serve.
          expected: expected.has(line.c),
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
