// GET /api/route?line=6450-10 — route of any SPTrans line, one feature per direction.
// Used to draw the route of a bike-rack bus running a line it doesn't usually serve.
// Source: GeoSampa (city open data), which has no CORS, hence this proxy.

import { cachedJson } from '../_lib/cache.js';
import { round, simplify } from '../_lib/geometry.js';

const WFS = 'https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows';
const TTL = 86_400; // routes change rarely
const LINE_CODE = /^[0-9A-Z]{4}-[0-9]{1,2}$/;

/** GeoSampa features -> [{ sentido, coordinates: [[lon, lat], ...] }]. */
export function normalizeRoute(geo) {
  return (geo?.features ?? []).flatMap((f) => {
    const g = f.geometry;
    const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    return parts.map((coords) => ({
      sentido: Number(f.properties?.cd_sentido_linha_onibus) || 1,
      coordinates: simplify(coords.map(([lon, lat]) => [round(lon), round(lat)])),
    }));
  });
}

export async function onRequestGet(context) {
  const line = new URL(context.request.url).searchParams.get('line')?.toUpperCase();
  if (!line || !LINE_CODE.test(line)) {
    return Response.json({ error: 'parâmetro line inválido (ex.: 6450-10)' }, { status: 400 });
  }
  return cachedJson(context, TTL, async () => {
    const url = new URL(WFS);
    url.search = new URLSearchParams({
      service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'geoportal:linha_onibus',
      outputFormat: 'application/json', srsName: 'EPSG:4326', CQL_FILTER: `cd_linha_geometria='${line}'`,
    });
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`GeoSampa: HTTP ${res.status}`);
    return { line, directions: normalizeRoute(await res.json()) };
  });
}
