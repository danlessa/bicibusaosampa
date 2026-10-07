import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { vehicleFilter } from '../functions/_lib/vehicles.js';
import { normalize } from '../functions/api/rail-status.js';
import { normalizeRoute } from '../functions/api/route.js';

test('selectVehicles keeps fleet buses on any line and flags unusual lines', () => {
  const select = vehicleFilter({ lines: [{ code: '809P-10' }] }, ['71858', '30001']);
  const snapshot = {
    hr: '12:26',
    l: [
      { c: '809P-10', sl: 1, lt0: 'TERM. PINHEIROS', lt1: 'TERM. CAMPO LIMPO', vs: [{ p: 71858, a: true, ta: 't', py: -23.6, px: -46.7 }] },
      { c: '809P-10', sl: 2, lt0: 'TERM. PINHEIROS', lt1: 'TERM. CAMPO LIMPO', vs: [{ p: 71250, a: false, ta: 't', py: -23.6, px: -46.7 }] },
      { c: '3459-10', sl: 2, lt0: 'TERM. PQ. D. PEDRO II', lt1: 'ITAIM PAULISTA', vs: [{ p: 30001, py: 0, px: 0 }, { p: 30002, py: 0, px: 0 }] },
    ],
  };
  const v = select(snapshot);
  assert.deepEqual(v.map((x) => x.prefix), ['71858', '30001']);
  assert.equal(v[0].expected, true);
  assert.equal(v[0].to, 'TERM. PINHEIROS');
  assert.equal(v[1].expected, false);
  assert.equal(v[1].to, 'ITAIM PAULISTA');
});

test('the fleet list has only 23 m superarticulated buses', () => {
  const fleet = JSON.parse(readFileSync(new URL('../data/bike-fleet.json', import.meta.url)));
  assert.deepEqual(fleet.types, ['A23']);
  assert.equal(fleet.prefixes.length, fleet.count);
  assert.ok(fleet.count > 1000);
});

test('normalizeRoute turns GeoSampa features into simplified directions', () => {
  const line = Array.from({ length: 50 }, (_, i) => [-46.6 + i * 0.0001, -23.5]);
  const out = normalizeRoute({
    features: [
      { properties: { cd_sentido_linha_onibus: 1 }, geometry: { type: 'LineString', coordinates: line } },
      { properties: { cd_sentido_linha_onibus: 2 }, geometry: { type: 'MultiLineString', coordinates: [line.slice(0, 2), line.slice(2, 4)] } },
    ],
  });
  assert.deepEqual(out.map((d) => d.sentido), [1, 2, 2]);
  assert.equal(out[0].coordinates.length, 2); // a straight line simplifies to its ends
});

test('normalize maps the Motiva feed by line number', () => {
  const out = normalize({
    data: {
      dataAtualizacao: '2026-09-30T12:25:28',
      concessoes: [
        { linhas: [{ numero: '4', statusLinha: { codigo: 'OperacaoNormal', status: 'Operação Normal', descricao: '' } }] },
        { linhas: [{ numero: 1, statusLinha: { codigo: 'OperacaoNormal', status: 'Operação Normal', descricao: 'Operação Normal' } }] },
      ],
    },
  });
  assert.equal(out.updated, '2026-09-30T12:25:28');
  assert.deepEqual(out.lines['4'], { code: 'OperacaoNormal', status: 'Operação Normal', description: null });
  assert.equal(out.lines['1'].description, null);
});
