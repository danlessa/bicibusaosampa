#!/usr/bin/env node
// Builds the data files:
//   public/data/rail.geojson        metro/train tracks and stations, from OpenStreetMap (Overpass)
//   public/data/bus-routes.geojson  routes of the expected bike-bus lines, from the SPTrans GTFS
//   public/data/bus-stops.geojson   stops served by those lines, from the SPTrans GTFS
//   public/data/lines/<code>.json   route and stops of every SPTrans bus line, from the GTFS
//   public/data/bike-parking.geojson bicicletários and paraciclos, from OSM and GeoSampa
//   data/bike-fleet.json            SPTrans buses with a bike rack, from the fleet CSV in assets/
//
// Usage: node scripts/build-data.mjs [rail|bus|parking|fleet]   (default: all)
// Downloads are cached in .cache/ for a day; delete it to force a refresh.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

import { round, simplify } from '../functions/_lib/geometry.js';
import { assignLanes } from './lanes.mjs';
import { buildParking } from './parking.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const FLEET_CSV = join(ROOT, 'assets', '00_businfo_consolidado.csv');
const FLEET_JSON = join(ROOT, 'data', 'bike-fleet.json');
// Vehicle types with a bike rack: the 23 m superarticulated buses ("Articulado 23m").
// The electric "E-Articulado 23m" (eA3) has no rack and is left out.
const BIKE_TYPES = new Set(['A23']);
const CACHE = join(ROOT, '.cache');
const DAY = 86_400_000;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const GTFS_URLS = [
  'https://files.mobilitydatabase.org/mdb-8/latest.zip',
  'https://www.sptrans.com.br/umbraco/Surface/PerfilDesenvolvedor/BaixarGTFS',
];

// Greater São Paulo (south, west, north, east), including Jundiaí for line 7.
const RMSP_BBOX = '-24.1,-47.2,-23.1,-46.0';
// The 39 municipalities of the Região Metropolitana de São Paulo (OSM relation 2661855).
const RMSP_AREA = 3_600_000_000 + 2_661_855;
const GEOSAMPA_WFS = 'https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows';


async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function cached(name, fetcher) {
  const path = join(CACHE, name);
  try {
    if (Date.now() - (await stat(path)).mtimeMs < DAY) return await readFile(path);
  } catch {}
  const body = Buffer.from(await fetcher());
  await mkdir(CACHE, { recursive: true });
  await writeFile(path, body);
  return body;
}

async function firstOk(urls, init) {
  let lastError;
  for (const url of urls) {
    try {
      console.log(`  GET ${url}`);
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(240_000) });
      if (res.ok) return await res.arrayBuffer();
      lastError = new Error(`${url}: HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    console.warn(`  failed: ${lastError.message}`);
  }
  throw lastError;
}

// ---------------------------------------------------------------- rail (OSM)

function overpass(query) {
  return firstOk(OVERPASS_ENDPOINTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bicibusaosampa/1.0 (+https://github.com/danlessa/bicibusaosampa)' },
    body: new URLSearchParams({ data: query }),
  });
}

async function buildRail() {
  console.log('Rail: fetching OpenStreetMap routes');
  const { lines } = await readJson(join(DATA, 'rail-lines.json'));
  const refs = lines.map((l) => l.ref).join('|');
  const query = `
    [out:json][timeout:180][bbox:${RMSP_BBOX}];
    relation["type"="route"]["route"~"^(subway|train|monorail|light_rail)$"]["ref"~"^(${refs})$"]->.r;
    .r out geom;
    node(r.r:"stop");
    out body;
    node(r.r:"stop_entry_only");
    out body;
    node(r.r:"stop_exit_only");
    out body;`;
  const raw = await cached('overpass-rail.json', () => overpass(query));
  const { elements } = JSON.parse(raw.toString('utf8'));

  const nodeTags = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e.tags ?? {}]));
  const tracks = new Map(); // ref -> Map(wayId -> coords)
  const stations = new Map(); // name -> { coords, refs:Set }

  for (const rel of elements.filter((e) => e.type === 'relation')) {
    const ref = rel.tags.ref;
    if (!tracks.has(ref)) tracks.set(ref, new Map());
    for (const m of rel.members) {
      if (m.type === 'way' && (m.role === '' || m.role === 'route') && m.geometry) {
        tracks.get(ref).set(m.ref, m.geometry.map((p) => [round(p.lon), round(p.lat)]));
      } else if (m.type === 'node' && m.role.startsWith('stop')) {
        const tags = nodeTags.get(m.ref) ?? {};
        const name = (tags.name ?? '').replace(/^Estação\s+/i, '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!stations.has(key)) stations.set(key, { name, coords: [round(m.lon), round(m.lat)], refs: new Set() });
        stations.get(key).refs.add(ref);
      }
    }
  }

  const order = new Map(lines.map((l, i) => [l.ref, i]));
  const features = [...tracks]
    .sort(([a], [b]) => order.get(a) - order.get(b))
    .map(([ref, ways]) => ({
      type: 'Feature',
      properties: { kind: 'track', ref },
      geometry: { type: 'MultiLineString', coordinates: [...ways.values()].map((w) => simplify(w)) },
    }));
  for (const s of stations.values()) {
    features.push({
      type: 'Feature',
      properties: { kind: 'station', name: s.name, refs: [...s.refs].sort((a, b) => order.get(a) - order.get(b)) },
      geometry: { type: 'Point', coordinates: s.coords },
    });
  }

  const missing = lines.filter((l) => !tracks.has(l.ref)).map((l) => l.ref);
  if (missing.length) console.warn(`  no OSM geometry for line(s): ${missing.join(', ')}`);
  await writeFile(join(DATA, 'rail.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  wrote rail.geojson: ${tracks.size} lines, ${stations.size} stations`);
}

// ---------------------------------------------------------------- buses (GTFS)

/** Minimal CSV parser for GTFS files (quoted fields, no embedded newlines). */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const fields = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let value = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { value += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else value += line[i++];
        }
        fields.push(value);
        i++; // skip comma
      } else {
        const end = line.indexOf(',', i);
        const stop = end === -1 ? line.length : end;
        fields.push(line.slice(i, stop));
        i = stop + 1;
      }
    }
    rows.push(fields);
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => [h.trim(), r[j]])));
}

async function buildBus() {
  console.log('Bus: fetching SPTrans GTFS');
  const config = await readJson(join(DATA, 'bike-buses.json'));
  const wanted = new Set(config.lines.map((l) => l.code));
  const zip = await cached('sptrans-gtfs.zip', () =>
    firstOk(GTFS_URLS, { headers: { 'User-Agent': 'curl/8 bicibusaosampa' } }),
  );
  const files = unzipSync(new Uint8Array(zip), {
    filter: (f) => ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt'].includes(f.name),
  });

  // Every bus line (route_type 3), not just the expected ones: the per-line files
  // let the map show any line a bike-rack bus happens to run.
  const routes = new Map(parseCsv(strFromU8(files['routes.txt'])).filter((r) => r.route_type === '3').map((r) => [r.route_id, r]));
  const trips = parseCsv(strFromU8(files['trips.txt'])).filter((t) => routes.has(t.route_id));
  const shapeIds = new Set(trips.map((t) => t.shape_id));

  const points = new Map(); // shape_id -> [[seq, lon, lat]]
  for (const line of strFromU8(files['shapes.txt']).split('\n')) {
    const cols = line.replaceAll('"', '').split(',');
    if (!shapeIds.has(cols[0])) continue;
    if (!points.has(cols[0])) points.set(cols[0], []);
    points.get(cols[0]).push([+cols[3], round(+cols[2]), round(+cols[1])]);
  }

  const directions = trips.map((t) => ({
    code: t.route_id,
    // GTFS direction 0 is Olho Vivo "sentido" 1 (main terminal -> secondary).
    sentido: +t.direction_id + 1,
    headsign: t.trip_headsign,
    coordinates: simplify((points.get(t.shape_id) ?? []).sort((a, b) => a[0] - b[0]).map(([, lon, lat]) => [lon, lat])),
  }));

  const tripRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));
  const stopLines = new Map(); // stop_id -> Set(route_id)
  for (const st of parseCsv(strFromU8(files['stop_times.txt']))) {
    const route = tripRoute.get(st.trip_id);
    if (!route) continue;
    if (!stopLines.has(st.stop_id)) stopLines.set(st.stop_id, new Set());
    stopLines.get(st.stop_id).add(route);
  }
  const stops = parseCsv(strFromU8(files['stops.txt']))
    .filter((st) => stopLines.has(st.stop_id))
    .map((st) => ({ id: st.stop_id, name: st.stop_name?.trim(), coordinates: [round(+st.stop_lon), round(+st.stop_lat)], lines: stopLines.get(st.stop_id) }));

  // Map layers for the expected lines.
  const features = directions.filter((d) => wanted.has(d.code)).map(({ coordinates, ...props }) => ({
    type: 'Feature',
    properties: { ...props, name: routes.get(props.code)?.route_long_name },
    geometry: { type: 'LineString', coordinates },
  }));
  // Lanes keep lines that share streets apart on the map (see public/js/offset.js).
  const byCode = {};
  for (const f of features) (byCode[f.properties.code] ??= []).push(f.geometry.coordinates);
  const lanes = assignLanes(byCode);
  for (const f of features) f.properties.lane = lanes[f.properties.code];

  const found = new Set(features.map((f) => f.properties.code));
  const missing = [...wanted].filter((c) => !found.has(c));
  if (missing.length) console.warn(`  line(s) not in GTFS: ${missing.join(', ')}`);
  await writeFile(join(DATA, 'bus-routes.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  wrote bus-routes.geojson: ${found.size} lines, ${features.length} directions`);

  const stopFeatures = stops
    .filter((st) => [...st.lines].some((c) => wanted.has(c)))
    .map((st) => ({
      type: 'Feature',
      properties: { id: st.id, name: st.name, lines: [...st.lines].filter((c) => wanted.has(c)).sort() },
      geometry: { type: 'Point', coordinates: st.coordinates },
    }));
  await writeFile(join(DATA, 'bus-stops.geojson'), JSON.stringify({ type: 'FeatureCollection', features: stopFeatures }));
  console.log(`  wrote bus-stops.geojson: ${stopFeatures.length} stops`);

  // One file per line: route and stops, loaded on demand (public/data/lines/<code>.json).
  const linesDir = join(DATA, 'lines');
  await rm(linesDir, { recursive: true, force: true });
  await mkdir(linesDir, { recursive: true });
  const stopsByLine = new Map();
  for (const st of stops) {
    for (const code of st.lines) {
      if (!stopsByLine.has(code)) stopsByLine.set(code, []);
      stopsByLine.get(code).push({ id: st.id, name: st.name, coordinates: st.coordinates });
    }
  }
  const dirsByLine = Map.groupBy(directions, (d) => d.code);
  for (const [code, route] of routes) {
    await writeFile(join(linesDir, `${code}.json`), JSON.stringify({
      code,
      name: route.route_long_name,
      directions: (dirsByLine.get(code) ?? []).map(({ sentido, headsign, coordinates }) => ({ sentido, headsign, coordinates })),
      stops: stopsByLine.get(code) ?? [],
    }));
  }
  console.log(`  wrote lines/: ${routes.size} line files`);
}

// ---------------------------------------------------------------- bike parking (OSM + GeoSampa)

async function buildParkingLayer() {
  console.log('Parking: fetching OpenStreetMap and GeoSampa');
  const query = `
    [out:json][timeout:180];
    area(id:${RMSP_AREA})->.rmsp;
    nwr["amenity"="bicycle_parking"](area.rmsp);
    out center tags;`;
  const osm = JSON.parse((await cached('overpass-parking.json', () => overpass(query))).toString('utf8'));
  const wfs = new URL(GEOSAMPA_WFS);
  wfs.search = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'geoportal:bicicletario_paraciclo',
    outputFormat: 'application/json', srsName: 'EPSG:4326',
  });
  const city = JSON.parse((await cached('geosampa-parking.json', () => firstOk([wfs.href]))).toString('utf8'));

  const features = buildParking(osm.elements ?? [], city.features ?? []);
  if (features.length < 100) throw new Error(`only ${features.length} parking spots, upstream looks broken`);
  await writeFile(join(DATA, 'bike-parking.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  const count = (key) => JSON.stringify(Object.groupBy(features, (f) => f.properties[key]), (k, v) => (Array.isArray(v) ? v.length : v));
  console.log(`  wrote bike-parking.geojson: ${features.length} spots ${count('kind')} ${count('access')}`);
}

// ---------------------------------------------------------------- fleet (CSV)

async function buildFleet() {
  let text;
  try {
    text = await readFile(FLEET_CSV, 'utf8');
  } catch {
    console.log(`Fleet: ${FLEET_CSV} not found, keeping data/bike-fleet.json`);
    return;
  }
  console.log('Fleet: reading the SPTrans fleet CSV');
  const [header, ...rows] = text.split(/\r?\n/).filter(Boolean).map((l) => l.split(';'));
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const prefixes = new Set();
  for (const r of rows) {
    if (r[col.cidade] === 'SP' && BIKE_TYPES.has(r[col.tipo])) prefixes.add(r[col.prefixo]);
  }
  const sorted = [...prefixes].sort((a, b) => a.localeCompare(b));
  await mkdir(dirname(FLEET_JSON), { recursive: true });
  await writeFile(FLEET_JSON, `${JSON.stringify({
    _comment: 'Gerado por scripts/build-data.mjs a partir do cadastro da frota (assets/00_businfo_consolidado.csv, fora do git): prefixos dos ônibus SPTrans "Articulado 23m" (superarticulados com suporte para bicicleta).',
    types: [...BIKE_TYPES],
    count: sorted.length,
    prefixes: sorted,
  })}\n`);
  console.log(`  wrote data/bike-fleet.json: ${sorted.length} vehicles`);
}

// A failed download keeps the previously committed file, so a flaky upstream
// (Overpass is often overloaded) never wipes a layer.
async function run(name, build) {
  try {
    await build();
  } catch (err) {
    console.error(`${name}: ${err.message} — keeping the existing file`);
    process.exitCode = 1;
  }
}

const which = process.argv[2];
if (!which || which === 'rail') await run('rail', buildRail);
if (!which || which === 'bus') await run('bus', buildBus);
if (!which || which === 'parking') await run('parking', buildParkingLayer);
if (!which || which === 'fleet') await run('fleet', buildFleet);
