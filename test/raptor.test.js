import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTransit, expandFrequencies, railRef } from '../scripts/routing.mjs';
import { liveTrips } from '../public/js/live-trips.js';
import { readFileSync } from 'node:fs';

import { balance, flatSpeed, INF, loadNetwork, plan, queryDay, stationTable } from '../public/js/raptor.js';

// São Paulo is UTC-3 all year. 2026-10-07 is a Wednesday.
const sp = (iso) => new Date(`${iso}-03:00`);
const NOON = sp('2026-10-07T12:00');
const RUSH = sp('2026-10-07T07:30');

const ALL_DAY = { weekday: [['00:00', '24:00']], saturday: [['00:00', '24:00']], sunday: [['00:00', '24:00']] };
const BIKE_HOURS = { weekday: [['10:00', '16:00']], saturday: [['00:00', '24:00']], sunday: [['00:00', '24:00']] };

// Eleven stops 1 km apart along an east–west street; origin at the first, destination at the last.
const LON = Array.from({ length: 11 }, (_, i) => -46.7 + i * 0.0098);
const ORIGIN = { lat: -23.55, lon: LON[0] };
const DEST = { lat: -23.55, lon: LON[10] };

function network(patterns, { lots = [] } = {}) {
  const transit = {
    services: { ALL: [1, 1, 1, 1, 1, 1, 1] },
    stops: { id: LON.map((_, i) => `s${i}`), name: LON.map((_, i) => `Parada ${i}`), lat: LON.map(() => -23.55), lon: LON },
    patterns: patterns.map((p) => ({
      dir: 0, headsign: 'Leste', service: 'ALL', rail: null,
      stops: LON.map((_, i) => i),
      offsets: LON.map((_, i) => i * p.perStop),
      departures: Array.from({ length: 200 }, (_, k) => 5 * 3600 + k * 300),
      ...p,
    })),
  };
  return loadNetwork({
    transit,
    railLines: { bikeRules: { bikes: BIKE_HOURS }, lines: [{ ref: '1', service: [ALL_DAY] }] },
    bikeBuses: { rules: { bikes: BIKE_HOURS }, lines: [{ code: 'HAB-10' }] },
    parking: {
      features: lots.map(([lon, access]) => ({
        geometry: { coordinates: [lon, -23.55] },
        properties: { kind: 'bicicletario', access, name: 'Bicicletário' },
      })),
    },
  });
}

const rides = (journey) => journey.legs.filter((l) => l.kind === 'ride');

test('flatSpeed matches the amora rider at the four power levels', () => {
  const kmh = (w) => Math.round(flatSpeed(w) * 3.6 * 10) / 10;
  assert.deepEqual([40, 80, 110, 150].map(kmh), [14.2, 20, 23.1, 26.3]);
});

test('the train carries the bike only inside the bike hours', () => {
  const net = network([{ route: 'METRÔ L1', mode: 'metro', rail: '1', perStop: 120 }]);
  const noon = plan(net, { from: ORIGIN, to: DEST, date: NOON, profile: 'carry' })[0];
  assert.equal(rides(noon)[0]?.route, 'METRÔ L1');
  assert.equal(rides(noon)[0].withBike, true);

  const rush = plan(net, { from: ORIGIN, to: DEST, date: RUSH, profile: 'carry' });
  assert.equal(rush.length, 1);
  assert.equal(rush[0].legs[0].kind, 'bike');

  // Without the bike the same train is fine at rush hour.
  assert.equal(rides(plan(net, { from: ORIGIN, to: DEST, date: RUSH, profile: 'walk' })[0])[0]?.route, 'METRÔ L1');
});

test('with the bike, buses are the usual 23m lines offline and the live 23m buses online', () => {
  const net = network([
    { route: 'CONV-10', mode: 'bus', perStop: 60 },
    { route: 'HAB-10', mode: 'bus', perStop: 90 },
  ]);
  const offline = plan(net, { from: ORIGIN, to: DEST, date: NOON, profile: 'carry' })[0];
  assert.equal(rides(offline)[0]?.route, 'HAB-10');
  assert.equal(rides(offline)[0].estimated, true);

  // A 23m bus diverted to CONV-10, 200 m east of the first stop: it can't be caught there.
  const day = queryDay(net, NOON);
  const at = new Date(NOON.getTime() + 60_000).toISOString();
  const live = liveTrips(net, [{ prefix: '12345', line: 'CONV-10', sentido: 1, lat: -23.55, lon: LON[0] + 0.002, at }], day);
  assert.deepEqual([...live.keys()], [0]);
  const trip = live.get(0)[0];
  assert.equal(trip.times[0], INF);
  assert.ok(trip.times[1] > day.now);

  // Starting at the second stop, the diverted bus beats the usual line.
  const from = { lat: -23.55, lon: LON[1] };
  const online = plan(net, { from, to: DEST, date: NOON, profile: 'carry', live, day })[0];
  assert.equal(rides(online)[0]?.route, 'CONV-10');
  assert.equal(rides(online)[0].live, '12345');
});

test('the bike can be left at a bicicletário to take a line that does not carry it', () => {
  const lines = [{ route: 'CONV-10', mode: 'bus', perStop: 60 }];
  const parked = plan(network(lines, { lots: [[LON[0], 'cadastro']] }), { from: ORIGIN, to: DEST, date: NOON, profile: 'bike' })[0];
  assert.deepEqual(parked.legs.map((l) => l.kind), ['bike', 'park', 'ride', 'walk']);

  // Open street stands don't count, and neither does a profile that keeps the bike.
  const noLot = plan(network(lines), { from: ORIGIN, to: DEST, date: NOON, profile: 'bike' })[0];
  assert.equal(noLot.rides, 0);
  const carry = plan(network(lines, { lots: [[LON[0], 'cadastro']] }), { from: ORIGIN, to: DEST, date: NOON, profile: 'carry' })[0];
  assert.equal(carry.rides, 0);
});

test('expandFrequencies and railRef read the SPTrans GTFS conventions', () => {
  const rows = [
    { start_time: '00:00:00', end_time: '00:59:00', headway_secs: '1200' },
    { start_time: '01:00:00', end_time: '01:59:00', headway_secs: '3600' },
  ];
  assert.deepEqual(expandFrequencies(rows, 0), [0, 1200, 2400, 3600]);
  assert.deepEqual(expandFrequencies([], 25_200), [25_200]);
  assert.deepEqual(['METRÔ L1', 'METRÔ 15', 'METRÔ17A', 'CPTM L07'].map(railRef), ['1', '15', '17', '7']);
});

test('buildTransit keeps each template trip as offsets plus departures', () => {
  const net = buildTransit({
    routes: [{ route_id: 'CPTM L07', route_type: '2' }],
    trips: [{ route_id: 'CPTM L07', service_id: 'USD', trip_id: 't', trip_headsign: 'JUNDIAI', direction_id: '0' }],
    stops: [
      { stop_id: 'a', stop_name: 'Luz', stop_lat: '-23.53', stop_lon: '-46.63' },
      { stop_id: 'b', stop_name: 'Barra Funda', stop_lat: '-23.52', stop_lon: '-46.66' },
    ],
    stopTimes: [
      { trip_id: 't', stop_id: 'b', stop_sequence: '2', arrival_time: '04:07:00', departure_time: '04:07:00' },
      { trip_id: 't', stop_id: 'a', stop_sequence: '1', arrival_time: '04:00:00', departure_time: '04:00:00' },
    ],
    frequencies: [{ trip_id: 't', start_time: '04:00:00', end_time: '04:30:00', headway_secs: '900' }],
    calendar: [{ service_id: 'USD', monday: '1', tuesday: '1', wednesday: '1', thursday: '1', friday: '1', saturday: '1', sunday: '1' }],
  });
  assert.deepEqual(net.stops.name, ['Luz', 'Barra Funda']);
  const [p] = net.patterns;
  assert.equal(p.mode, 'train');
  assert.equal(p.rail, '7');
  assert.deepEqual(p.offsets, [0, 420]);
  assert.deepEqual(p.departures, [14_400, 15_300, 16_200]);
});

// Line 1 runs east along stops 0–5; line 2 starts 150 m north of stop 5 and goes on east.
const NORTH = -23.55 + 150 / 110_574;
function twoLines(stations = null) {
  const stops = [...LON.slice(0, 6).map((lon) => [-23.55, lon]), ...LON.slice(5).map((lon) => [NORTH, lon])];
  const line = (route, rail, idx) => ({
    route, mode: 'metro', rail, dir: 0, headsign: 'Leste', service: 'ALL',
    stops: idx, offsets: idx.map((_, i) => i * 120),
    departures: Array.from({ length: 200 }, (_, k) => 5 * 3600 + k * 300),
  });
  return loadNetwork({
    transit: {
      services: { ALL: [1, 1, 1, 1, 1, 1, 1] },
      stops: { id: stops.map((_, i) => `s${i}`), name: stops.map((_, i) => `Estação ${i}`), lat: stops.map((p) => p[0]), lon: stops.map((p) => p[1]) },
      patterns: [line('METRÔ L1', '1', [0, 1, 2, 3, 4, 5]), line('METRÔ L2', '2', [6, 7, 8, 9, 10, 11])],
    },
    railLines: { bikeRules: { bikes: BIKE_HOURS }, lines: [{ ref: '1', service: [ALL_DAY] }, { ref: '2', service: [ALL_DAY] }] },
    bikeBuses: { rules: { bikes: BIKE_HOURS }, lines: [] },
    parking: { features: [] },
    stations,
  });
}
const DEEP = {
  types: { profunda: { walkS: 150, bikeS: 300, upIn: 0, upOut: 25 } },
  lines: { 1: 'profunda', 2: 'profunda' },
  transfers: [{ between: ['Estação 5|1', 'Estação 6|2'], walkS: 240, bikeS: 420 }],
};

test('changing lines with the bike walks it between the stations', () => {
  const j = plan(twoLines(), { from: ORIGIN, to: { lat: NORTH, lon: LON[10] }, date: NOON, profile: 'carry' })[0];
  assert.deepEqual(j.legs.map((l) => l.kind), ['bike', 'ride', 'walk', 'ride', 'bike']);
  const change = j.legs[2];
  assert.equal(change.withBike, true);
  // 150 m × 1.3 at pushing pace (85% of 4.5 km/h), not at cycling speed.
  assert.ok(Math.abs(change.arrive - change.depart - (150 * 1.3) / (1.25 * 0.85)) < 5, `${change.arrive - change.depart} s`);
});

test('stations add the way in, the way out and the timed interchange', () => {
  const j = plan(twoLines(DEEP), { from: ORIGIN, to: { lat: NORTH, lon: LON[10] }, date: NOON, profile: 'carry' })
    .find((x) => x.rides === 2);
  assert.deepEqual(j.legs.map((l) => l.kind), ['bike', 'station', 'ride', 'walk', 'ride', 'station', 'bike']);
  const [inn, change, out] = [j.legs[1], j.legs[3], j.legs[5]];
  assert.equal(inn.arrive - inn.depart, 300);
  assert.equal(inn.down, 25);
  assert.equal(out.up, 25);
  assert.ok(out.kcal > inn.kcal, 'climbing out with the bike costs more');
  assert.equal(change.interchange, true);
  assert.equal(change.arrive - change.depart, 420);
});

test('stationTable reports keys that match no stop', () => {
  const table = stationTable({ ...DEEP, stations: { 'Nowhere|1': 'profunda' } }, twoLines().patterns, LON.concat(LON).map((_, i) => `Estação ${i}`), 12);
  assert.deepEqual(table.missing, ['Nowhere|1']);
  assert.equal(table.transfers.get(5)[0].to, 6);
});

test('every station and interchange in stations.json matches a GTFS stop', () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
  const transit = read('routing/transit.json');
  const patterns = transit.patterns.map((p) => ({ ...p, stops: Int32Array.from(p.stops) }));
  const table = stationTable(read('stations.json'), patterns, transit.stops.name, transit.stops.id.length);
  assert.deepEqual(table.missing, []);
});

test('balance ranks by kcal plus k × minutes, without repeats', () => {
  const j = (min, kcal, route) => ({ depart: 0, arrive: min * 60, energy: kcal * 4184, kcal, legs: [{ kind: 'ride', route, to: { stop: route } }] });
  // k = 1: A 56 + 152 = 208; B 86 + 56 = 142; C 74 + 68 = 142 (earlier arrival first); D 67 + 62 = 129
  const all = [j(56, 152, 'A'), j(86, 56, 'B'), j(74, 68, 'C'), j(67, 62, 'D'), j(56, 152, 'A')];
  assert.deepEqual(balance(all, 1).map((x) => x.legs[0].route), ['D', 'C', 'B', 'A']);
  // k = 3, the default: D 263, C 290, B 314, A 320
  assert.deepEqual(balance(all).map((x) => x.legs[0].route), ['D', 'C', 'B', 'A']);
  // k = 10 (time counts most): A 712, D 732, C 808, B 916
  assert.deepEqual(balance(all, 10).map((x) => x.legs[0].route), ['A', 'D', 'C', 'B']);
  // A fast enough option wins at k = 10 but not at k = 1.
  const pair = [j(40, 120, 'fast'), j(80, 70, 'easy')];
  assert.equal(balance(pair, 10)[0].legs[0].route, 'fast');
  assert.equal(balance(pair, 1)[0].legs[0].route, 'easy');
});
