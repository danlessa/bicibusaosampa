import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headingOnRoute } from '../public/js/heading.js';
import { assignLanes } from '../public/js/offset.js';

const distance = (p, route) => headingOnRoute(p, route)?.distance ?? Infinity;
const street = (lat) => Array.from({ length: 30 }, (_, i) => [lat, -46.65 + i * 0.001]);

test('lines sharing a street get different lanes, others reuse lane 0', () => {
  const lanes = assignLanes({
    A: [street(-23.55)],
    B: [street(-23.55), street(-23.5501)], // same street as A, both directions
    C: [street(-23.60)], // elsewhere
  }, distance);
  assert.equal(lanes.A, 0);
  assert.equal(lanes.B, 1);
  assert.equal(lanes.C, 0);
});
