import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOpeningHours } from '../scripts/opening-hours.mjs';
import { buildParking, fromGeoSampa, fromOsm, titleCase } from '../scripts/parking.mjs';
import { parkingStatus } from '../public/js/parking.js';

// São Paulo is UTC-3 all year.
const sp = (iso) => new Date(`${iso}-03:00`);

test('parseOpeningHours handles the forms used on bike parking', () => {
  const all = [['04:00', '23:59']];
  assert.deepEqual(parseOpeningHours('Mo-Su 04:00-23:59'), { weekday: all, saturday: all, sunday: all });
  assert.deepEqual(parseOpeningHours('Mo-Su,PH 04:40-24:00').holiday, [['04:40', '24:00']]);
  assert.deepEqual(parseOpeningHours('Mo-Fr 07:00-19:00'), { weekday: [['07:00', '19:00']], saturday: [], sunday: [] });
  assert.deepEqual(parseOpeningHours('Mo-Sa 06:00-22:00; Su off').sunday, []);
  assert.deepEqual(parseOpeningHours('Mo-Fr 22:00-02:00').weekday, [['22:00', '26:00']]);
  assert.deepEqual(parseOpeningHours('Mo-Su 08:00-12:00,13:00-18:00').sunday, [['08:00', '12:00'], ['13:00', '18:00']]);
  assert.equal(parseOpeningHours('24/7').sunday[0][1], '24:00');
});

test('parseOpeningHours refuses what it cannot represent', () => {
  assert.equal(parseOpeningHours('Mo-Th 08:00-18:00; Fr 08:00-17:00'), null);
  assert.equal(parseOpeningHours('sunrise-sunset'), null);
  assert.equal(parseOpeningHours('Jan-Mar Mo-Fr 08:00-12:00'), null);
  assert.equal(parseOpeningHours(''), null);
});

test('fromOsm tells paraciclos from bicicletários and classifies access', () => {
  assert.deepEqual(fromOsm({ amenity: 'bicycle_parking', bicycle_parking: 'stands', capacity: '10', covered: 'no' }),
    { kind: 'paraciclo', access: 'livre', capacity: 10 });
  const cptm = fromOsm({
    amenity: 'bicycle_parking', bicycle_parking: 'building', supervised: 'yes', name: 'Bicicletário Estação Osasco',
    operator: 'CPTM', opening_hours: 'Mo-Su 04:00-23:59', 'authentication:biometric': 'yes',
  });
  assert.equal(cptm.kind, 'bicicletario');
  assert.equal(cptm.access, 'cadastro');
  assert.equal(cptm.covered, true);
  assert.equal(cptm.biometric, true);
  assert.deepEqual(cptm.hours.weekday, [['04:00', '23:59']]);
  // SPTrans terminals: run by Socicam, tagged as stands, not supervised.
  assert.equal(fromOsm({ amenity: 'bicycle_parking', bicycle_parking: 'stands', supervised: 'no', name: 'Bicicletário Terminal Lapa', operator: 'Socicam' }).access, 'cadastro');
  // A station bicicletário mistagged as private is still open to anyone who signs up.
  assert.equal(fromOsm({ amenity: 'bicycle_parking', bicycle_parking: 'building', access: 'private', operator: 'ViaMobilidade' }).access, 'cadastro');
  assert.equal(fromOsm({ amenity: 'bicycle_parking', access: 'private' }), null);
  assert.equal(fromOsm({ amenity: 'bicycle_parking', access: 'customers' }).access, 'clientes');
  assert.equal(fromOsm({ amenity: 'bicycle_parking', access: 'customers', fee: 'yes', supervised: 'yes' }).access, 'pago');
  assert.equal(fromOsm({ amenity: 'bicycle_parking', opening_hours: '24/7' }).hours, '24h');
  assert.equal(fromOsm({ amenity: 'bicycle_parking', opening_hours: 'Mo-Th 08:00-18:00; Fr 08:00-17:00' }).hours, undefined);
});

test('GeoSampa names and operators are tidied', () => {
  assert.equal(titleCase('ESTACAO VILA LOBOS- JAGUARE'), 'Estação Vila Lobos - Jaguare');
  assert.equal(titleCase('TERMINAL PARQUE DOM PEDRO II'), 'Terminal Parque Dom Pedro Ii');
  assert.deepEqual(fromGeoSampa({ tx_tipo_equipamento: 'BICICLETARIO', nm_local: 'TERMINAL SAO MIGUEL', qt_vaga: 64, nm_orgao_responsavel: 'SPTRANS' }),
    { kind: 'bicicletario', access: 'cadastro', name: 'Bicicletário Terminal São Miguel', operator: 'SPTrans', capacity: 64, covered: true });
  assert.equal(fromGeoSampa({ tx_tipo_equipamento: 'PARACICLO', nm_orgao_responsavel: 'METRÔ - MONOTRI' }).operator, 'Metrô');
});

test('buildParking merges a GeoSampa point into the same OSM parking nearby', () => {
  const osm = [
    { type: 'way', id: 1, center: { lat: -23.5, lon: -46.6 }, tags: { amenity: 'bicycle_parking', bicycle_parking: 'building', operator: 'CPTM' } },
    { type: 'node', id: 2, lat: -23.6, lon: -46.7, tags: { amenity: 'bicycle_parking', access: 'private' } },
  ];
  const city = [
    { geometry: { type: 'Point', coordinates: [-46.6005, -23.5005] }, properties: { tx_tipo_equipamento: 'BICICLETARIO', qt_vaga: 80 } }, // ~75 m away
    { geometry: { type: 'Point', coordinates: [-46.6005, -23.5005] }, properties: { tx_tipo_equipamento: 'PARACICLO', qt_vaga: 8 } }, // other kind
    { geometry: { type: 'Point', coordinates: [-46.65, -23.55] }, properties: { tx_tipo_equipamento: 'BICICLETARIO' } }, // far
  ];
  const features = buildParking(osm, city);
  assert.equal(features.length, 3);
  assert.equal(features[0].properties.osm, 'way/1');
  assert.equal(features[0].properties.capacity, 80);
  assert.deepEqual(features.slice(1).map((f) => [f.properties.kind, f.properties.source]), [['paraciclo', 'geosampa'], ['bicicletario', 'geosampa']]);
});

test('parkingStatus says whether it is open now', () => {
  const hours = { weekday: [['06:00', '22:00']], saturday: [['06:00', '22:00']], sunday: [] };
  const p = { kind: 'bicicletario', access: 'cadastro', hours };
  assert.deepEqual(parkingStatus(p, sp('2026-10-07T10:00')), { open: true, colorKey: 'cadastro', detail: 'Aberto até 22:00' });
  assert.deepEqual(parkingStatus(p, sp('2026-10-07T23:00')), { open: false, colorKey: 'closed', detail: 'Fechado · abre amanhã 06:00' });
  // Sunday, and Monday 12/10 is a holiday (Sunday hours), so it opens on Tuesday.
  assert.equal(parkingStatus(p, sp('2026-10-11T10:00')).detail, 'Fechado · abre ter 06:00');
  assert.equal(parkingStatus({ ...p, hours: { weekday: [['04:40', '24:00']] } }, sp('2026-10-07T10:00')).detail, 'Aberto até meia-noite');
  assert.equal(parkingStatus({ ...p, hours: '24h' }).detail, 'Aberto 24 horas');
  assert.equal(parkingStatus({ kind: 'paraciclo', access: 'livre' }).open, null);
  assert.equal(parkingStatus({ kind: 'paraciclo', access: 'livre' }).colorKey, 'livre');
});
