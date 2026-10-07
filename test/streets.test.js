import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreets, CLASS, FLAG, wayAccess } from '../scripts/streets.mjs';
import { bikeModel, decodeStreets, pathNodes, snap, streetSearch, walkSpeed } from '../public/js/streets.js';

test('wayAccess reads what walking and cycling may do from OSM tags', () => {
  assert.equal(wayAccess({ highway: 'motorway' }), null);
  assert.equal(wayAccess({ highway: 'residential', access: 'private' }), null);
  assert.equal(wayAccess({ highway: 'trunk' }).flags & FLAG.noBike, FLAG.noBike);
  assert.equal(wayAccess({ highway: 'trunk', bicycle: 'yes' }).flags & FLAG.noBike, 0);

  const footway = wayAccess({ highway: 'footway' });
  assert.equal(footway.flags & 7, CLASS.foot);
  assert.equal(footway.flags & FLAG.push, FLAG.push);
  assert.equal(wayAccess({ highway: 'footway', bicycle: 'designated' }).flags & 7, CLASS.cycleway);
  assert.equal(wayAccess({ highway: 'steps' }).flags & FLAG.push, FLAG.push);

  assert.equal(wayAccess({ highway: 'residential', oneway: 'yes' }).flags & FLAG.oneway, FLAG.oneway);
  assert.equal(wayAccess({ highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' }).flags & FLAG.oneway, 0);
  assert.equal(wayAccess({ highway: 'residential', oneway: 'yes', cycleway: 'opposite_lane' }).flags & FLAG.oneway, 0);
  assert.equal(wayAccess({ highway: 'primary', junction: 'roundabout' }).flags & FLAG.oneway, FLAG.oneway);
  assert.equal(wayAccess({ highway: 'secondary', oneway: '-1' }).reverse, true);
  assert.equal(wayAccess({ highway: 'primary', 'cycleway:right': 'lane' }).flags & FLAG.infra, FLAG.infra);
});

// A ~190 m square: A(0,0) B(0,1) C(1,1) D(1,0). A → B is one-way, so a bike from B
// to A goes round by C and D, while walking takes the short side.
function square() {
  const d = 0.0018;
  const coords = new Map([[1, [-23.55, -46.65]], [2, [-23.55, -46.65 + d]], [3, [-23.55 + d, -46.65 + d]], [4, [-23.55 + d, -46.65]]]);
  const ways = new Map([
    [10, { nodes: [1, 2], tags: { highway: 'residential', oneway: 'yes' } }],
    [11, { nodes: [2, 3, 4, 1], tags: { highway: 'residential' } }],
  ]);
  // Uphill to the north: 10 m over 200 m.
  const { buffer } = buildStreets(ways, coords, (lat) => (lat + 23.55) * 5555);
  return decodeStreets(buffer);
}

test('buildStreets round-trips through decodeStreets', () => {
  const g = square();
  assert.ok(g.N >= 4);
  assert.ok(g.E >= 4);
  // 0.0018° is ~199 m north–south and ~184 m east–west at this latitude.
  const total = g.len.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 766) < 5, `total length ${total}`);
  const top = snap(g, -23.5482, -46.65, 'walk');
  assert.ok(Math.abs(g.elev[top.node] - 10) < 0.6, `elevation ${g.elev[top.node]}`);
});

test('bikes respect one-way streets, walking does not', () => {
  const g = square();
  const a = snap(g, -23.55, -46.65, 'bike').node, b = snap(g, -23.55, -46.6482, 'bike').node;
  const bike = bikeModel(80);
  const ride = streetSearch(g, { sources: [{ node: b, t: 0, e: 0 }], mode: 'bike', bike, target: a });
  const walk = streetSearch(g, { sources: [{ node: b, t: 0, e: 0 }], mode: 'walk', bike, target: a, slot: 1 });
  assert.ok(pathNodes(ride, a).length > pathNodes(walk, a).length);
  // With the one-way, the same ride is short.
  const forward = streetSearch(g, { sources: [{ node: a, t: 0, e: 0 }], mode: 'bike', bike, target: b, slot: 2 });
  assert.ok(forward.time[b] < ride.time[a] / 2);
});

test('the bike and walking models slow down uphill', () => {
  const m = bikeModel(80);
  const at = (grade) => m.speed[Math.round((grade + 0.3) / 0.0025)] * 3.6;
  assert.ok(Math.abs(at(0) - 20) < 0.5);
  // Climbs over 2% get twice the power, as in amora: 6% is ~11.5 km/h at 80 W.
  assert.ok(at(0.06) < at(0) * 0.65);
  assert.ok(at(0.06) > 10);
  assert.ok(at(-0.1) <= 35);
  assert.ok(Math.abs(walkSpeed(0) * 3.6 - 4.5) < 0.01);
  assert.ok(walkSpeed(0.15) < walkSpeed(0));
});
