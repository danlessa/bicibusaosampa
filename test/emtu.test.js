import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { emtuVehicles } from '../functions/_lib/emtu.js';
import { decodePolyline } from '../functions/_lib/geometry.js';
import { emtuFeatures, stopName } from '../scripts/emtu.mjs';
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
          { sentido: 'ida', destino: 'SBC', encode: '_p~iF~ps|U_ulLnnqC', pontos: [ponto(1, 'Rua A, 10 - Centro, Osasco - SP, 06020-012, Brasil'), ponto(2, 'B')] },
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
  assert.deepEqual(routes.map((f) => [f.properties.code, f.properties.sentido, f.properties.headsign]), [['280', 1, 'SBC'], ['280', 2, 'Osasco'], ['378', 1, undefined]]);
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
