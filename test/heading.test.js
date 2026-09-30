import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headingOfMove, headingOnRoute, iconTransform } from '../public/js/heading.js';

// Points around Av. Paulista ([lat, lon]).
const route = [[-23.5700, -46.6500], [-23.5700, -46.6400], [-23.5600, -46.6400]]; // east, then north

test('headingOnRoute picks the nearest segment', () => {
  const east = headingOnRoute([-23.5701, -46.6450], route);
  assert.ok(Math.abs(east.angle) < 1);
  assert.ok(east.distance < 15);
  const north = headingOnRoute([-23.5650, -46.6399], route);
  assert.ok(Math.abs(north.angle - 90) < 1);
});

test('headingOfMove ignores jitter', () => {
  assert.equal(headingOfMove([-23.57, -46.65], [-23.57, -46.65005]), null); // ~5 m
  assert.ok(Math.abs(Math.abs(headingOfMove([-23.57, -46.64], [-23.57, -46.65])) - 180) < 1); // west
});

test('iconTransform never turns the bus upside down', () => {
  assert.equal(iconTransform(null), '');
  assert.equal(iconTransform(0), 'rotate(0.0deg)');
  assert.equal(iconTransform(45), 'rotate(-45.0deg)'); // north-east: nose up
  assert.equal(iconTransform(180), 'rotate(0.0deg) scaleX(-1)'); // west: mirrored
  assert.equal(iconTransform(135), 'rotate(45.0deg) scaleX(-1)'); // north-west: mirrored, nose up
  assert.equal(iconTransform(-135), 'rotate(-45.0deg) scaleX(-1)'); // south-west
});
