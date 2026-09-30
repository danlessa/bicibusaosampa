#!/usr/bin/env node
// Builds the static map layers in public/data/:
//   rail.geojson        tracks and stations of metro/train lines, from OpenStreetMap (Overpass)
//   bus-routes.geojson  routes of the bike-carrying bus lines, from the SPTrans GTFS
//   bus-stops.geojson   stops served by those lines, from the SPTrans GTFS
//
// Usage: node scripts/build-data.mjs [rail|bus]   (default: both)
// Downloads are cached in .cache/ for a day; delete it to force a refresh.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
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

const round = (x) => Math.round(x * 1e5) / 1e5;

// Douglas–Peucker simplification of [lon, lat] points. The tolerance (~2 m) is
// invisible on the map and roughly halves the file sizes.
const SIMPLIFY_TOLERANCE = 0.00002;

function simplify(pts, tol = SIMPLIFY_TOLERANCE) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || Number.EPSILON;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

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
  const raw = await cached('overpass-rail.json', () =>
    firstOk(OVERPASS_ENDPOINTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bicibusaosampa/1.0 (+https://github.com/danlessa/bicibusaosampa)' },
      body: new URLSearchParams({ data: query }),
    }),
  );
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

  const routes = new Map(parseCsv(strFromU8(files['routes.txt'])).map((r) => [r.route_id, r]));
  const trips = parseCsv(strFromU8(files['trips.txt'])).filter((t) => wanted.has(t.route_id));
  const shapeIds = new Set(trips.map((t) => t.shape_id));

  const points = new Map(); // shape_id -> [[seq, lon, lat]]
  for (const line of strFromU8(files['shapes.txt']).split('\n')) {
    const cols = line.replaceAll('"', '').split(',');
    if (!shapeIds.has(cols[0])) continue;
    if (!points.has(cols[0])) points.set(cols[0], []);
    points.get(cols[0]).push([+cols[3], round(+cols[2]), round(+cols[1])]);
  }

  const features = trips.map((t) => ({
    type: 'Feature',
    properties: {
      code: t.route_id,
      // GTFS direction 0 is Olho Vivo "sentido" 1 (main terminal -> secondary).
      sentido: +t.direction_id + 1,
      headsign: t.trip_headsign,
      name: routes.get(t.route_id)?.route_long_name,
    },
    geometry: {
      type: 'LineString',
      coordinates: simplify((points.get(t.shape_id) ?? []).sort((a, b) => a[0] - b[0]).map(([, lon, lat]) => [lon, lat])),
    },
  }));

  const found = new Set(trips.map((t) => t.route_id));
  const missing = [...wanted].filter((c) => !found.has(c));
  if (missing.length) console.warn(`  line(s) not in GTFS: ${missing.join(', ')}`);
  await writeFile(join(DATA, 'bus-routes.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`  wrote bus-routes.geojson: ${found.size} lines, ${features.length} directions`);

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
    .map((st) => ({
      type: 'Feature',
      properties: { id: st.stop_id, name: st.stop_name?.trim(), lines: [...stopLines.get(st.stop_id)].sort() },
      geometry: { type: 'Point', coordinates: [round(+st.stop_lon), round(+st.stop_lat)] },
    }));
  await writeFile(join(DATA, 'bus-stops.geojson'), JSON.stringify({ type: 'FeatureCollection', features: stops }));
  console.log(`  wrote bus-stops.geojson: ${stops.length} stops`);
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
