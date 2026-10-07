// Transit network for the trip planner: turns the SPTrans GTFS (buses, Metrô and CPTM)
// into public/data/routing/transit.json, read by public/js/raptor.js.
//
// The SPTrans GTFS is frequency-based: one template trip per line and direction
// (stop_times relative to its first departure) plus headways per hour
// (frequencies.txt). Each pattern keeps that template as offsets and the expanded
// departures from its first stop, so the client never stores per-trip stop times.

import { round } from '../functions/_lib/geometry.js';

const MODES = { 1: 'metro', 2: 'train', 3: 'bus' };
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function seconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Rail line ref used by rail-lines.json ("METRÔ L1" → "1", "CPTM L07" → "7", "METRÔ17A" → "17"). */
export function railRef(routeId) {
  const m = routeId.match(/(\d+)/);
  return m ? String(Number(m[1])) : null;
}

/** Departures from the first stop: every headway from start_time up to end_time. */
export function expandFrequencies(rows, firstDeparture) {
  if (!rows.length) return [firstDeparture];
  const out = [];
  for (const r of rows) {
    const start = seconds(r.start_time), end = seconds(r.end_time), step = Number(r.headway_secs);
    if (!(step > 0)) continue;
    for (let t = start; t <= end; t += step) out.push(t);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Builds the network from parsed GTFS tables (arrays of row objects). */
export function buildTransit({ routes, trips, stops, stopTimes, frequencies, calendar }) {
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  const stopById = new Map(stops.map((s) => [s.stop_id, s]));

  const timesByTrip = new Map();
  for (const st of stopTimes) {
    let list = timesByTrip.get(st.trip_id);
    if (!list) timesByTrip.set(st.trip_id, (list = []));
    list.push(st);
  }
  const freqByTrip = new Map();
  for (const f of frequencies) {
    let list = freqByTrip.get(f.trip_id);
    if (!list) freqByTrip.set(f.trip_id, (list = []));
    list.push(f);
  }

  const stopIndex = new Map();
  const out = { id: [], name: [], lat: [], lon: [] };
  const indexOf = (id) => {
    let i = stopIndex.get(id);
    if (i === undefined) {
      const s = stopById.get(id);
      if (!s) return -1;
      i = out.id.length;
      stopIndex.set(id, i);
      out.id.push(id);
      out.name.push(s.stop_name);
      out.lat.push(round(Number(s.stop_lat)));
      out.lon.push(round(Number(s.stop_lon)));
    }
    return i;
  };

  const patterns = [];
  for (const t of trips) {
    const route = routeById.get(t.route_id);
    const mode = route && MODES[route.route_type];
    const times = timesByTrip.get(t.trip_id);
    if (!mode || !times?.length) continue;
    times.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const first = seconds(times[0].departure_time || times[0].arrival_time);
    const stopIdx = [], offsets = [];
    for (const st of times) {
      const i = indexOf(st.stop_id);
      if (i < 0) continue;
      stopIdx.push(i);
      offsets.push(seconds(st.arrival_time || st.departure_time) - first);
    }
    if (stopIdx.length < 2) continue;
    patterns.push({
      route: t.route_id,
      dir: Number(t.direction_id) || 0,
      mode,
      rail: mode === 'bus' ? null : railRef(t.route_id),
      headsign: t.trip_headsign,
      service: t.service_id,
      stops: stopIdx,
      offsets,
      departures: expandFrequencies(freqByTrip.get(t.trip_id) ?? [], first),
    });
  }

  const services = Object.fromEntries(calendar.map((c) => [c.service_id, DAYS.map((d) => Number(c[d]) || 0)]));
  return {
    _comment: 'Gerado por scripts/build-data.mjs a partir do GTFS da SPTrans (ônibus, Metrô e CPTM). Rede do planejador de viagens: cada padrão é uma linha num sentido, com os tempos de cada parada a partir da primeira (offsets, em segundos) e as partidas da primeira parada no dia (departures, segundos desde a meia-noite). services: dias da semana (seg..dom) de cada service_id.',
    version: 1,
    services,
    stops: out,
    patterns,
  };
}
