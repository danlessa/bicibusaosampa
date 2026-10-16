import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { emtuVehicles } from '../functions/_lib/emtu.js';
import { decodePolyline } from '../functions/_lib/geometry.js';
import { departures, distancesAlong, emtuFeatures, emtuGtfs, stopName, toCsv } from '../scripts/emtu.mjs';
import { assignLanes } from '../scripts/lanes.mjs';

const NOW = Date.UTC(2026, 9, 16, 0, 50);

test('emtuVehicles maps the relay snapshot and skips stale positions', () => {
  const vehicle = (prefixo, sentidoLinha, minutesAgo, extra = {}) => ({
    prefixo, codigoLinha: '280', sentidoLinha, latitude: -23.58, longitude: -46.69,
    dataUltimaTransmissao: NOW - minutesAgo * 60_000, acessibilidade: 'não', ...extra,
  });
  const v = emtuVehicles({
    linhas: [
      {
        codigo: '280',
        rotas: [
          { sentido: 'ida', cidade: 'OSASCO (CENTRO)', destino: 'SAO BERNARDO DO CAMPO (TERMINAL PACO)' },
          { sentido: 'volta', cidade: 'SAO BERNARDO DO CAMPO (TERMINAL PACO)', destino: 'OSASCO (CENTRO)' },
        ],
        veiculos: [vehicle('20126', 'ida', 5), vehicle('20133', 'volta', 1, { acessibilidade: 'sim' }), vehicle('20119', 'ida', 90)],
      },
      { codigo: '218EX1', rotas: [{ sentido: 'circular', destino: 'SAO PAULO (GLICERIO)' }], veiculos: [vehicle('81203', 'circular', 2, { codigoLinha: '218EX1' })] },
    ],
  }, NOW);
  assert.deepEqual(v.map((x) => [x.prefix, x.line, x.sentido]), [['20126', '280', 1], ['20133', '280', 2], ['81203', '218EX1', 1]]);
  assert.equal(v[0].agency, 'emtu');
  assert.equal(v[0].expected, true);
  assert.equal(v[0].to, 'SAO BERNARDO DO CAMPO (TERMINAL PACO)');
  assert.equal(v[1].to, 'OSASCO (CENTRO)');
  assert.equal(v[1].accessible, true);
  assert.equal(v[0].at, new Date(NOW - 5 * 60_000).toISOString());
  assert.deepEqual(emtuVehicles(null), []);
});

test('decodePolyline reads Google encoded polylines as [lon, lat]', () => {
  // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  assert.deepEqual(decodePolyline(''), []);
});

test('emtuFeatures builds routes and merges shared stops', () => {
  const ponto = (id, endereco) => ({ id, endereco, latitude: -23.5, longitude: -46.6 });
  const details = {
    280: {
      linhas: [{
        codigo: '280', tarifa: 14.2,
        rotas: [
          { sentido: 'ida', destino: 'SAO BERNARDO DO CAMPO', encode: '_p~iF~ps|U_ulLnnqC', pontos: [ponto(1, 'Rua A, 10 - Centro, Osasco - SP, 06020-012, Brasil'), ponto(2, 'B')] },
          { sentido: 'volta', destino: 'Osasco', encode: '_ulLnnqC_p~iF~ps|U', pontos: [ponto(2, 'B')] },
        ],
      }],
    },
    378: { linhas: [{ codigo: '378', rotas: [{ sentido: 'ida', encode: '_p~iF~ps|U_ulLnnqC', pontos: [ponto(2, 'B')] }] }] },
    999: { linhas: [] },
  };
  const config = { lines: [{ code: '280', name: 'Osasco – SBC', operator: 'Anhanguera' }, { code: '378' }, { code: '999' }] };
  const { routes, stops, missing } = emtuFeatures(details, config);
  assert.deepEqual(missing, ['999']);
  assert.deepEqual(routes.map((f) => [f.properties.code, f.properties.sentido, f.properties.headsign]), [['280', 1, 'Sao Bernardo do Campo'], ['280', 2, 'Osasco'], ['378', 1, '']]);
  assert.equal(routes[0].properties.fare, 14.2);
  assert.equal(routes[0].properties.agency, 'emtu');
  assert.deepEqual(stops.map((f) => [f.properties.id, f.properties.lines]), [['emtu-1', ['280']], ['emtu-2', ['280', '378']]]);
  assert.equal(stops[0].properties.name, 'Rua A, 10 - Centro, Osasco');
});

test('stopName trims country, postcode and state', () => {
  assert.equal(stopName('Avenida Maria Campos, 384 - Centro, Osasco - SP, 06020-012, Brasil'), 'Avenida Maria Campos, 384 - Centro, Osasco');
  assert.equal(stopName('Terminal Metropolitano Jabaquara '), 'Terminal Metropolitano Jabaquara');
});

test('assignLanes keeps clear of lanes already taken by another layer', () => {
  const street = [[[-46.70, -23.55], [-46.60, -23.55]]];
  const lanes = assignLanes({ E1: street }, { taken: { S1: { routes: street, lane: 0 }, S2: { routes: street, lane: 1 } } });
  assert.deepEqual(lanes, { E1: 2 });
});

test('the EMTU config lists unique seletivo lines with names', () => {
  const config = JSON.parse(readFileSync(new URL('../public/data/emtu-seletivo.json', import.meta.url)));
  const codes = config.lines.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((c) => /^[0-9A-Z]{1,8}$/.test(c) && !c.includes('-')), 'EMTU codes must not look like SPTrans ones');
  assert.ok(config.lines.every((l) => l.name && l.operator));
  assert.ok(config.rules.summary);
});

test('departures reads the timetable lists, past midnight after a wrap', () => {
  assert.deepEqual(departures('4:40,5:15, 23:50,0:20'), [16_800, 18_900, 85_800, 87_600]);
  assert.deepEqual(departures(''), []);
  assert.deepEqual(departures(null), []);
});

test('distancesAlong keeps stops in order where the route passes a street twice', () => {
  // East 2 km, then back west on the other carriageway, 16 m south. Stops 1 km out on
  // each side: the return stop is 16 m from the outward pass, but belongs 2 km later.
  const k = 1 / (111_320 * Math.cos((23.55 * Math.PI) / 180));
  const south = -23.55 - 16 / 110_540;
  const line = [[-46.7, -23.55], [-46.7 + 2000 * k, -23.55], [-46.7 + 2000 * k, south], [-46.7, south]];
  const d = distancesAlong(line, [line[0], [-46.7 + 1000 * k, -23.55], [-46.7 + 1000 * k, south], line[3]]);
  assert.ok(Math.abs(d[1] - 1000) < 5 && Math.abs(d[2] - 3016) < 5 && Math.abs(d[3] - 4016) < 5, d.join());
  assert.equal(distancesAlong([[0, 0]], [[0, 0]]), null);
});

test('emtuGtfs spreads the trip time along the route and runs Sundays on holidays', () => {
  const encode = 'nrvnC~a`|G?_pR'; // -23.55, -46.7 → -23.55, -46.6
  const pontos = [0, 0.25, 1].map((f, i) => ({ id: 10 + i, sequencia: i, endereco: `P${i}`, latitude: -23.55, longitude: -46.7 + f * 0.1 }));
  const details = {
    280: { linhas: [{ codigo: '280', rotas: [{ sentido: 'ida', destino: 'Leste', tempo: 40, encode, pontos, horariosdiasuteis: '5:00,6:00', horariossabados: '', horariosdomingosferiados: '8:00' }] }] },
    838: { linhas: [{ codigo: '838', rotas: [{ sentido: 'volta', destino: 'Oeste', tempo: 20, encode, pontos, horarios: '17:35', horariosdiasuteis: '', horariossabados: '', horariosdomingosferiados: '' }] }] },
  };
  const config = { lines: [{ code: '280', name: 'A – B', operator: 'Anhanguera' }, { code: '838', name: 'C – D' }] };
  // 2026-10-17 is a Saturday; 2026-11-02 (Finados) a Monday.
  const g = emtuGtfs(details, config, { today: '2026-10-17' });

  assert.deepEqual(g['trips.txt'].map((t) => [t.trip_id, t.service_id, t.direction_id, t.bikes_allowed]), [
    ['280-ida-weekday-0500', 'emtu-weekday', 0, 1],
    ['280-ida-weekday-0600', 'emtu-weekday', 0, 1],
    ['280-ida-sunday-0800', 'emtu-sunday', 0, 1],
    // Only `horarios`: the timetable of the day the feed was read (a Saturday).
    ['838-volta-saturday-1735', 'emtu-saturday', 1, 1],
  ]);
  const times = g['stop_times.txt'].filter((s) => s.trip_id === '280-ida-weekday-0500');
  assert.deepEqual(times.map((s) => s.arrival_time), ['05:00:00', '05:10:00', '05:40:00']);
  assert.deepEqual(times.map((s) => s.timepoint), [1, 0, 0]);
  assert.equal(times[1].stop_id, 'emtu-11');

  assert.deepEqual(
    g['calendar_dates.txt'].filter((d) => d.date === '20261102'),
    [{ service_id: 'emtu-sunday', date: '20261102', exception_type: 1 }, { service_id: 'emtu-weekday', date: '20261102', exception_type: 2 }],
  );
  assert.equal(g['calendar.txt'][0].start_date, '20261017');
  assert.equal(g['calendar.txt'][0].end_date, '20271017');
  assert.equal(g['routes.txt'][0].route_color, '0E7490');
  assert.ok(g['shapes.txt'].length >= 2);
});

test('toCsv quotes commas and quotes', () => {
  assert.equal(toCsv([{ a: 'x, y', b: 'say "hi"', c: null }]), 'a,b,c\n"x, y","say ""hi""",\n');
  assert.equal(toCsv([]), '');
});
