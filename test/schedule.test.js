import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { easter, holidayName } from '../public/js/time.js';
import { bikeStatus } from '../public/js/schedule.js';
import { railStatus } from '../public/js/rail.js';

const rail = JSON.parse(readFileSync(new URL('../public/data/rail-lines.json', import.meta.url)));
const bus = JSON.parse(readFileSync(new URL('../public/data/bike-buses.json', import.meta.url)));
const line = (ref) => rail.lines.find((l) => l.ref === ref);
// São Paulo is UTC-3 all year (no DST since 2019).
const sp = (local) => new Date(`${local}-03:00`);
const status = (ref, local, live) => railStatus(line(ref), rail.bikeRules.bikes, live, sp(local));

test('holidays', () => {
  assert.equal(easter(2026), '2026-04-05');
  assert.equal(easter(2027), '2027-03-28');
  assert.equal(holidayName('2026-04-03'), 'Sexta-feira Santa');
  assert.equal(holidayName('2026-06-04'), 'Corpus Christi');
  assert.equal(holidayName('2026-11-20'), 'Dia da Consciência Negra');
  assert.equal(holidayName('2026-02-17'), null); // Carnival Tuesday is not a holiday
  assert.equal(holidayName('2026-09-30'), null);
});

test('rail on a weekday (Wed 2026-09-30)', () => {
  assert.deepEqual(
    [status('1', '2026-09-30T09:59').status, status('1', '2026-09-30T10:00').status, status('1', '2026-09-30T15:59').status],
    ['wait', 'ok', 'ok'],
  );
  const afternoon = status('1', '2026-09-30T17:00');
  assert.equal(afternoon.status, 'wait');
  assert.match(afternoon.detail, /21:00/);
  const night = status('4', '2026-09-30T21:30');
  assert.equal(night.status, 'ok');
  assert.match(night.detail, /fechamento \(amanhã 00:00\)/);
  const early = status('10', '2026-09-30T02:00');
  assert.equal(early.status, 'closed');
  assert.match(early.detail, /abre 04:00/);
  assert.equal(status('1', '2026-09-30T04:30').status, 'closed');
  assert.equal(status('1', '2026-09-30T04:45').status, 'wait');
});

test('rail on weekends and holidays', () => {
  assert.equal(status('7', '2026-10-03T06:00').status, 'ok'); // Saturday
  assert.equal(status('7', '2026-10-04T12:00').status, 'ok'); // Sunday
  assert.equal(status('9', '2026-10-12T08:00').status, 'ok'); // Monday holiday
  assert.equal(status('9', '2026-10-13T08:00').status, 'wait'); // Tuesday
});

test('Metrô runs overnight Saturday→Sunday until the pilot ends', () => {
  assert.equal(status('1', '2026-10-04T02:00').status, 'ok');
  assert.equal(status('4', '2026-10-04T02:00').status, 'closed'); // ViaQuatro is not in the pilot
  assert.equal(status('1', '2026-10-05T02:00').status, 'closed'); // Sunday→Monday night
  assert.equal(status('1', '2027-02-07T02:00').status, 'closed'); // after 2027-01-31
  const sat = status('3', '2026-10-03T23:00');
  assert.match(sat.detail, /seg 00:00/); // Sat all day + Sun all day, then closes Sunday midnight
});

test('lines with reduced hours', () => {
  assert.equal(status('6', '2026-09-30T12:00').status, 'ok');
  assert.equal(status('6', '2026-09-30T16:00').status, 'closed');
  assert.equal(status('6', '2026-10-03T12:00').status, 'closed');
  assert.equal(status('17', '2026-09-30T21:30').status, 'ok');
  assert.match(status('17', '2026-09-30T21:30').detail, /fechamento \(22:00\)/);
  assert.equal(status('17', '2026-10-04T12:00').status, 'closed');
});

test('live status overrides the timetable', () => {
  const stopped = status('1', '2026-09-30T12:00', { code: 'Paralisada', status: 'Paralisada', description: 'Falha' });
  assert.equal(stopped.status, 'closed');
  const slow = status('1', '2026-09-30T12:00', { code: 'VelocidadeReduzida', status: 'Velocidade Reduzida', description: null });
  assert.equal(slow.status, 'ok');
  assert.equal(slow.live, 'Velocidade Reduzida');
  // A stale "normal" at night does not reopen a closed line.
  assert.equal(status('1', '2026-09-30T02:00', { code: 'OperacaoNormal' }).status, 'closed');
});

test('bus bike windows (Portaria SMT 32/2016)', () => {
  const b = (local) => bikeStatus({ bikes: bus.rules.bikes }, sp(local));
  assert.equal(b('2026-09-30T08:00').status, 'wait');
  assert.equal(b('2026-09-30T10:30').status, 'ok');
  assert.equal(b('2026-09-30T17:00').status, 'wait');
  assert.match(b('2026-09-30T17:00').detail, /19:01/);
  assert.equal(b('2026-09-30T23:00').status, 'ok');
  assert.equal(b('2026-10-01T05:30').status, 'ok');
  assert.match(b('2026-10-02T23:00').detail, /amanhã 06:00/); // Friday night into Saturday
  assert.equal(b('2026-10-03T10:00').status, 'wait'); // Saturday morning
  assert.match(b('2026-10-03T10:00').detail, /14:00/);
  assert.equal(b('2026-10-04T10:00').status, 'ok'); // Sunday
});
