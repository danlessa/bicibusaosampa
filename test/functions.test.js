import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectVehicles } from '../functions/api/buses.js';
import { normalize } from '../functions/api/rail-status.js';

test('selectVehicles keeps listed lines and listed prefixes', () => {
  const snapshot = {
    hr: '12:26',
    l: [
      { c: '809P-10', sl: 1, lt0: 'TERM. PINHEIROS', lt1: 'TERM. CAMPO LIMPO', vs: [{ p: 71858, a: true, ta: 't', py: -23.6, px: -46.7 }] },
      { c: '809P-10', sl: 2, lt0: 'TERM. PINHEIROS', lt1: 'TERM. CAMPO LIMPO', vs: [{ p: 71250, a: false, ta: 't', py: -23.6, px: -46.7 }] },
      { c: '1012-10', sl: 1, lt0: 'A', lt1: 'B', vs: [{ p: 1, py: 0, px: 0 }] },
    ],
  };
  const v = selectVehicles(snapshot);
  assert.deepEqual(v.map((x) => x.prefix), ['71858', '71250']);
  assert.equal(v[0].to, 'TERM. PINHEIROS');
  assert.equal(v[1].to, 'TERM. CAMPO LIMPO');
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
