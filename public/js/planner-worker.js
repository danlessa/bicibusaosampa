// Trip planner worker: loads the transit network once and answers plan requests off
// the main thread, so the map stays responsive while the network loads (~1 s) and
// while routes are searched.
//
// Messages (every reply echoes `id`):
//   { kind: 'load' }                                   → { kind: 'loaded' }
//   { kind: 'plan', from, to, profile, power, optimize, timeWeight, avoidArterials, at, vehicles }
//        at = epoch ms; vehicles = /api/buses vehicles, or null to use the usual lines
//                                                      → { kind: 'done', journeys, live, streets }
//   failure                                            → { kind: 'error', message }

import { liveTrips } from './live-trips.js';
import { loadNetwork, plan, queryDay } from './raptor.js';
import { decodeStreets } from './streets.js';

const data = (name) => new URL(`../data/${name}`, import.meta.url);

// Download progress of the two big files, reported as { kind: 'progress', loaded, total }
// (bytes) so the panel can show it. Sizes fall back to the usual ones when the
// response doesn't say (compressed responses have no Content-Length).
const EXPECTED = { 'routing/transit.json': 3.7e6, 'routing/streets.bin': 14.5e6 };
const got = {}, sizes = { ...EXPECTED };
function report() {
  const loaded = Object.values(got).reduce((a, b) => a + b, 0);
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  self.postMessage({ kind: 'progress', loaded: Math.min(loaded, total), total });
}

async function fetchTracked(name) {
  const res = await fetch(data(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  if (!(name in EXPECTED) || !res.body) return res.arrayBuffer();
  const length = Number(res.headers.get('content-length'));
  if (length && !res.headers.get('content-encoding')) sizes[name] = length;
  const reader = res.body.getReader(), chunks = [];
  let n = 0, lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    got[name] = n;
    if (n - lastReport > 256e3) { lastReport = n; report(); }
  }
  got[name] = sizes[name] = n;
  report();
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.buffer;
}

async function getJson(url) {
  const name = url.pathname.split('/data/')[1];
  if (name in EXPECTED) return JSON.parse(new TextDecoder().decode(await fetchTracked(name)));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return res.json();
}

// Without the street graph (missing or failed), walking and cycling are straight lines.
async function getStreets() {
  try {
    return decodeStreets(await fetchTracked('routing/streets.bin'));
  } catch {
    return null;
  }
}

let network = null;
function getNetwork() {
  network ??= Promise.all([
    ...['routing/transit.json', 'rail-lines.json', 'bike-buses.json', 'bike-parking.geojson', 'stations.json'].map((n) => getJson(data(n))),
    getStreets(),
  ])
    .then(([transit, railLines, bikeBuses, parking, stations, streets]) => loadNetwork({ transit, railLines, bikeBuses, parking, stations, streets }))
    .catch((err) => { network = null; throw err; });
  return network;
}

self.onmessage = async ({ data: m }) => {
  try {
    const net = await getNetwork();
    if (m.kind === 'load') {
      self.postMessage({ id: m.id, kind: 'loaded' });
      return;
    }
    const day = queryDay(net, new Date(m.at));
    const live = m.vehicles ? liveTrips(net, m.vehicles, day) : null;
    const journeys = plan(net, { from: m.from, to: m.to, profile: m.profile, power: m.power, optimize: m.optimize, timeWeight: m.timeWeight, avoidArterials: m.avoidArterials, live, day });
    self.postMessage({ id: m.id, kind: 'done', journeys, live: !!live, streets: !!net.streets });
  } catch (err) {
    self.postMessage({ id: m.id, kind: 'error', message: err?.message ?? String(err) });
  }
};
