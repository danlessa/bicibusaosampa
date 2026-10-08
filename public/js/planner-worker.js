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

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return res.json();
}

// Without the street graph (missing or failed), walking and cycling are straight lines.
async function getStreets() {
  try {
    const res = await fetch(data('routing/streets.bin'));
    if (!res.ok) return null;
    return decodeStreets(await res.arrayBuffer());
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
