// Bike parking: turns OpenStreetMap `amenity=bicycle_parking` elements and the city's
// official list (GeoSampa `bicicletario_paraciclo`) into map features.
//
// kind:   'bicicletario' (staffed or enclosed parking) or 'paraciclo' (open stands)
// access: 'livre'     anyone, free, no sign-up
//         'cadastro'  free, after signing up on site (station and terminal bicicletários)
//         'pago'      paid
//         'clientes'  customers or permit holders only
// Private parking is left out.

import { round } from '../functions/_lib/geometry.js';
import { parseOpeningHours } from './opening-hours.mjs';

// Bicicletários at rail stations and bus terminals: free, but you sign up on site with
// a photo ID (CPTM also asks for proof of address). Socicam runs the SPTrans terminals.
const TRANSIT_OPERATOR = /metr[oô]|cptm|via ?mobilidade|via ?quatro|socicam|sptrans|emtu|tembici|linha ?uni|tic trens|motiva/i;
const ENCLOSED = new Set(['building', 'shed', 'lockers']);
const RESTRICTED = new Set(['customers', 'permit', 'destination', 'delivery']);
// GeoSampa points are often 50–200 m from the same parking in OSM.
const SAME_PLACE_METERS = 250;

const yes = (v) => v === 'yes';

/** Map properties for an OSM bike parking, or null when it isn't open to the public. */
export function fromOsm(tags) {
  if (!tags || tags.amenity !== 'bicycle_parking') return null;
  const transit = TRANSIT_OPERATOR.test(tags.operator ?? '');
  const kind = ENCLOSED.has(tags.bicycle_parking) || yes(tags.supervised) || /^biciclet[aá]rio\b/i.test(tags.name ?? '')
    ? 'bicicletario' : 'paraciclo';
  const signUp = Object.entries(tags).some(([k, v]) => k.startsWith('authentication:') && k !== 'authentication:none' && yes(v));

  let access;
  if (yes(tags.fee)) access = 'pago';
  // Station bicicletários are sometimes tagged private, though anyone may sign up.
  else if (kind === 'bicicletario' && transit) access = 'cadastro';
  else if (['private', 'no'].includes(tags.access)) return null;
  else if (RESTRICTED.has(tags.access)) access = 'clientes';
  else if (kind === 'bicicletario' && (yes(tags.supervised) || signUp)) access = 'cadastro';
  else access = 'livre';

  const props = { kind, access };
  if (tags.name) props.name = tags.name;
  if (tags.operator) props.operator = tags.operator;
  const capacity = parseInt(tags.capacity, 10);
  if (capacity > 0) props.capacity = capacity;
  if (yes(tags.covered) || ENCLOSED.has(tags.bicycle_parking)) props.covered = true;
  if (tags.opening_hours) {
    const hours = parseOpeningHours(tags.opening_hours);
    if (tags.opening_hours.trim() === '24/7') props.hours = '24h';
    else if (hours) props.hours = hours;
  }
  if (yes(tags['authentication:biometric'])) props.biometric = true;
  return props;
}

const OPERATORS = {
  SPTRANS: 'SPTrans', METRO: 'Metrô', 'METRÔ': 'Metrô', CPTM: 'CPTM', EMTU: 'EMTU',
  'VIA MOBILIDADE': 'ViaMobilidade', 'VIA QUATRO': 'ViaQuatro',
};
const SMALL_WORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
const WORDS = { ESTACAO: 'Estação', 'ESTAÇÃO': 'Estação', SE: 'Sé', SAO: 'São', JOAO: 'João', R: 'Rua', NSRA: 'Nossa Senhora', AE: 'A.E.',
  TERM: 'Terminal', HID: 'Hidroviário', PQ: 'Parque', TRANSFERENCIA: 'Transferência',
};

/** "ESTACAO VILA LOBOS- JAGUARE" -> "Estação Vila Lobos - Jaguare". */
export function titleCase(text) {
  return text.trim().replace(/\s*-\s*/g, ' - ').split(/\s+/).map((w, i) => {
    if (WORDS[w]) return WORDS[w];
    const lower = w.toLocaleLowerCase('pt-BR');
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/^(\(?)(\p{L})/u, (_, p, c) => p + c.toLocaleUpperCase('pt-BR'));
  }).join(' ');
}

/** Map properties for a GeoSampa feature. */
export function fromGeoSampa(p) {
  const bicicletario = p.tx_tipo_equipamento === 'BICICLETARIO';
  const props = {
    kind: bicicletario ? 'bicicletario' : 'paraciclo',
    access: bicicletario ? 'cadastro' : 'livre',
    name: `${bicicletario ? 'Bicicletário' : 'Paraciclo'} ${titleCase(p.nm_local ?? '')}`.trim(),
  };
  const operator = p.nm_orgao_responsavel?.split(/\s+-\s+/)[0].trim();
  if (operator) props.operator = OPERATORS[operator.toUpperCase()] ?? titleCase(operator);
  if (p.qt_vaga > 0) props.capacity = p.qt_vaga;
  if (bicicletario) props.covered = true;
  return props;
}

function meters([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  return 6_371_000 * Math.hypot((lon2 - lon1) * r * Math.cos(lat1 * r), (lat2 - lat1) * r);
}

/**
 * Features from OSM elements (`out center tags`) and GeoSampa features. A GeoSampa
 * point of the same kind near an OSM one is taken to be the same place: it only fills
 * in a missing capacity. The rest are added as they are.
 */
export function buildParking(osmElements, geoSampaFeatures) {
  const features = [];
  for (const el of osmElements) {
    const props = fromOsm(el.tags);
    const at = el.type === 'node' ? el : el.center;
    if (!props || !at) continue;
    features.push({
      type: 'Feature',
      properties: { ...props, osm: `${el.type}/${el.id}` },
      geometry: { type: 'Point', coordinates: [round(at.lon), round(at.lat)] },
    });
  }
  const fromOsmCount = features.length;
  for (const f of geoSampaFeatures) {
    if (f.geometry?.type !== 'Point') continue;
    const props = fromGeoSampa(f.properties ?? {});
    const coordinates = f.geometry.coordinates.map(round);
    let match = null, best = SAME_PLACE_METERS;
    for (const o of features.slice(0, fromOsmCount)) {
      if (o.properties.kind !== props.kind) continue;
      const d = meters(coordinates, o.geometry.coordinates);
      if (d < best) { best = d; match = o; }
    }
    if (match) match.properties.capacity ??= props.capacity;
    else features.push({ type: 'Feature', properties: { ...props, source: 'geosampa' }, geometry: { type: 'Point', coordinates } });
  }
  return features;
}
