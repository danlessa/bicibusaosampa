// Turns the EMTU seletivo snapshot from the relay (GET /emtu, built from
// rest-emtu.noxxonsat.com.br lineDetails) into the vehicle shape of /api/buses.
// Kept free of JSON imports so Node tests can load it directly.

// The API's directions: "ida" and "volta", or "circular" for one-way loops.
export const EMTU_SENTIDO = { ida: 1, volta: 2, circular: 1 };
// Parked buses keep their last position for hours: skip those not heard from lately.
const MAX_AGE_MS = 15 * 60_000;

/** `snapshot` = { linhas: [{ codigo, rotas: [{ sentido, cidade, destino }], veiculos }] }. */
export function emtuVehicles(snapshot, now = Date.now()) {
  const vehicles = [];
  for (const line of snapshot?.linhas ?? []) {
    const routes = new Map((line.rotas ?? []).map((r) => [r.sentido, r]));
    for (const v of line.veiculos ?? []) {
      const at = Number(v.dataUltimaTransmissao); // ms since the epoch
      if (!(now - at < MAX_AGE_MS) || !Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;
      const route = routes.get(v.sentidoLinha);
      vehicles.push({
        agency: 'emtu',
        prefix: String(v.prefixo),
        line: String(line.codigo ?? v.codigoLinha),
        expected: true,
        sentido: EMTU_SENTIDO[v.sentidoLinha] ?? 1,
        to: route?.destino ?? '',
        from: route?.cidade ?? '',
        lat: v.latitude,
        lon: v.longitude,
        at: new Date(at).toISOString(),
        accessible: v.acessibilidade === 'sim',
      });
    }
  }
  return vehicles;
}
