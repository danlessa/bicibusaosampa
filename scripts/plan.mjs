#!/usr/bin/env node
// Trip planner from the command line, for trying public/js/raptor.js on real data.
//
//   node scripts/plan.mjs --from=-23.5614,-46.6558 --to=-23.5428,-46.4719
//        [--at 2026-10-07T11:00] [--power suave|endorfinado|intenso|competicao|<W>]
//        [--profile walk,bike,carry] [--optimize time|energy|balanced] [--time-weight 1|3|10] [--allow-arterials] [--offline]
//
// --at is São Paulo time; without it, now. Live 23m buses come from
// busao.bicisampa.info/api/buses unless --offline (or --at is set).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { liveTrips } from '../public/js/live-trips.js';
import { loadNetwork, plan, POWER_LEVELS, queryDay } from '../public/js/raptor.js';
import { decodeStreets } from '../public/js/streets.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const LIVE_URL = 'https://busao.bicisampa.info/api/buses';
const PROFILE_NAMES = {
  walk: 'A pé + transporte',
  bike: 'De bici (pode deixá-la num bicicletário)',
  carry: 'Com a bici o tempo todo',
};
const MODE_ICON = { bus: '🚌', metro: '🚇', train: '🚆' };

const { values: args } = parseArgs({
  options: {
    from: { type: 'string' }, to: { type: 'string' }, at: { type: 'string' },
    power: { type: 'string', default: 'endorfinado' },
    profile: { type: 'string', default: 'walk,bike' },
    optimize: { type: 'string', default: 'time' },
    'allow-arterials': { type: 'boolean', default: false },
    'time-weight': { type: 'string', default: '3' },
    offline: { type: 'boolean', default: false },
  },
});
if (!args.from || !args.to) {
  console.error('usage: node scripts/plan.mjs --from=LAT,LON --to=LAT,LON [--at YYYY-MM-DDTHH:MM] [--power suave] [--profile walk,bike,carry] [--offline]');
  process.exit(2);
}
const point = (s) => { const [lat, lon] = s.split(',').map(Number); return { lat, lon }; };
const power = POWER_LEVELS[args.power] ?? Number(args.power);
const date = args.at ? new Date(`${args.at}-03:00`) : new Date();

const readJson = async (name) => JSON.parse(await readFile(join(DATA, name), 'utf8'));
let t = performance.now();
const streetsFile = join(DATA, 'routing', 'streets.bin');
let streets = null;
if (existsSync(streetsFile)) {
  const buf = await readFile(streetsFile);
  streets = decodeStreets(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const net = loadNetwork({
  streets,
  stations: await readJson('stations.json'),
  transit: await readJson('routing/transit.json'),
  railLines: await readJson('rail-lines.json'),
  bikeBuses: await readJson('bike-buses.json'),
  parking: await readJson('bike-parking.geojson'),
});
console.log(`rede carregada em ${Math.round(performance.now() - t)} ms: ${net.stops.count} paradas, ${net.patterns.length} padrões, ${net.lots.length} bicicletários, ${streets ? `ruas: ${streets.N} nós` : 'sem grafo de ruas (linha reta)'}`);

const day = queryDay(net, date);
let live = null;
if (!args.offline && !args.at) {
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(20_000) });
    const { vehicles } = await res.json();
    live = liveTrips(net, vehicles, day);
    const n = [...live.values()].reduce((a, l) => a + l.length, 0);
    console.log(`ao vivo: ${n} de ${vehicles.length} superarticulados posicionados em ${live.size} linhas/sentidos`);
  } catch (err) {
    console.log(`ao vivo indisponível (${err.message}); usando as linhas habituais`);
  }
}

const hhmm = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

function describe(leg) {
  const span = `${hhmm(leg.depart)}–${hhmm(leg.arrive)}`;
  if (leg.interchange) return `🚶 ${span} baldeação ${leg.from.name} → ${leg.to.name}${leg.withBike ? ' empurrando a bici' : ''}`;
  if (leg.kind === 'walk') return `🚶 ${span} ${leg.from.name} → ${leg.to.name} (${km(leg.meters)})${leg.withBike ? ' empurrando a bici' : ''}`;
  if (leg.kind === 'bike') return `🚲 ${span} ${leg.from.name} → ${leg.to.name} (${km(leg.meters)})`;
  if (leg.kind === 'station') {
    const climb = leg.up ? `sobe ${leg.up} m` : leg.down ? `desce ${leg.down} m` : '';
    return `🚉 ${span} ${leg.dir === 'in' ? 'entra na' : 'sai da'} estação ${leg.at.name}${leg.withBike ? ' com a bici' : ''}${climb ? ` (${climb})` : ''}`;
  }
  if (leg.kind === 'park') return `🅿️  ${span} deixa a bici: ${leg.at.name} (${leg.at.access})`;
  const line = leg.mode === 'bus' ? leg.route : `Linha ${leg.rail}`;
  const tag = leg.live ? ` · ônibus ${leg.live} ao vivo` : leg.estimated ? ' · estimado (linha habitual)' : '';
  return `${MODE_ICON[leg.mode]} ${span} ${line} sentido ${leg.headsign}: ${leg.from.name} → ${leg.to.name} (${leg.stops} paradas)${leg.withBike ? ' com a bici' : ''}${tag}`;
}

console.log(`saída ${hhmm(day.now)} · ${args.power} (${power} W) · ${{ energy: 'menos esforço', balanced: 'balanceado' }[args.optimize] ?? 'mais rápido'}\n`);
for (const profile of args.profile.split(',')) {
  t = performance.now();
  const journeys = plan(net, { from: point(args.from), to: point(args.to), profile, power, optimize: args.optimize, timeWeight: Number(args['time-weight']), avoidArterials: !args['allow-arterials'], live, day });
  console.log(`== ${PROFILE_NAMES[profile]} (${Math.round(performance.now() - t)} ms)`);
  journeys.splice(6);
  if (!journeys.length) console.log('  nenhuma opção');
  for (const j of journeys) {
    console.log(`  ${hhmm(j.depart)} → ${hhmm(j.arrive)} · ${Math.round((j.arrive - j.depart) / 60)} min · ${Math.round(j.kcal)} kcal · ${j.rides} condução(ões)`);
    for (const leg of j.legs) console.log(`     ${describe(leg)}`);
  }
  console.log();
}
