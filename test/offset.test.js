import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignLanes } from '../scripts/lanes.mjs';

// [lon, lat] routes along a street at latitude `lat`.
const street = (lat, from = -46.65, n = 30) => Array.from({ length: n }, (_, i) => [from + i * 0.001, lat]);

test('lines sharing a street get different lanes, others reuse lanes', () => {
  const lanes = assignLanes({
    A: [street(-23.55)],
    B: [street(-23.55), street(-23.5501)], // same street as A, both directions
    C: [street(-23.60)], // elsewhere
  });
  assert.notEqual(lanes.A, lanes.B);
  assert.equal(lanes.C, 0);
});

test('lanes are capped, reusing the least crowded one', () => {
  const routes = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((k) => [k, [street(-23.55)]]));
  const lanes = assignLanes(routes, { maxLanes: 3 });
  assert.ok(Object.values(lanes).every((l) => l >= 0 && l < 3));
  assert.deepEqual(new Set(Object.values(lanes)), new Set([0, 1, 2]));
});
