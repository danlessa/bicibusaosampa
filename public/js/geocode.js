// Place search and reverse lookup with Photon (komoot's OpenStreetMap geocoder), which,
// unlike Nominatim, allows search-as-you-type. Results are limited to Greater São Paulo
// and ranked by distance to the map's centre.

const PHOTON = 'https://photon.komoot.io';
const BBOX = '-47.2,-23.9,-46.0,-23.1'; // west, south, east, north (Greater SP, Jundiaí; not the coast)

function describe(p) {
  const street = [p.street, p.housenumber].filter(Boolean).join(', ');
  const label = p.name || street;
  const detail = [p.name && street, p.district, p.city].filter(Boolean).join(' · ');
  return { label, detail };
}

/** Places matching `query` near `near` (L.LatLng): [{ label, detail, lat, lon }]. */
export async function searchPlaces(query, near, signal) {
  const params = new URLSearchParams({
    q: query, limit: '6', bbox: BBOX,
    lat: near.lat.toFixed(5), lon: near.lng.toFixed(5), location_bias_scale: '0.4',
  });
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`busca: HTTP ${res.status}`);
  const seen = new Set();
  const out = [];
  for (const f of (await res.json()).features ?? []) {
    const p = f.properties ?? {};
    const key = `${p.osm_type}/${p.osm_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { label, detail } = describe(p);
    if (!label) continue;
    const [lon, lat] = f.geometry.coordinates;
    // The same place often comes back twice (a square and its street, a node and its
    // building): keep the first of each name within ~300 m.
    if (out.some((o) => o.label === label && Math.abs(o.lat - lat) < 0.003 && Math.abs(o.lon - lon) < 0.003)) continue;
    out.push({ label, detail, lat, lon });
  }
  return out;
}

/** A short name for the spot at lat/lon (street and number, or a place name), or null. */
export async function placeName(lat, lon) {
  try {
    const res = await fetch(`${PHOTON}/reverse?${new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6), limit: '1' })}`);
    if (!res.ok) return null;
    const p = (await res.json()).features?.[0]?.properties;
    return p ? describe(p).label || null : null;
  } catch {
    return null;
  }
}
