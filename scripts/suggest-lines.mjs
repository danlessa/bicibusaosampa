#!/usr/bin/env node
// Lists the lines the bike-rack buses (data/bike-fleet.json) are running right now,
// to keep the expected lines in public/data/bike-buses.json up to date.
//
// Usage: node scripts/suggest-lines.mjs [--write]
//   --write  adds the lines that look regular (MIN_BUSES+ rack buses making up at least
//            MIN_SHARE of the line's buses) to bike-buses.json. It never removes lines;
//            lines with no rack bus right now are only listed.
// Needs SPTRANS_TOKEN in the environment or in .env. Run it at a busy hour.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'public', 'data', 'bike-buses.json');
const API = 'https://api.olhovivo.sptrans.com.br/v2.1';
const MIN_BUSES = 3;
const MIN_SHARE = 0.2;

try { process.loadEnvFile(join(ROOT, '.env')); } catch {}
const token = process.env.SPTRANS_TOKEN;
if (!token) throw new Error('SPTRANS_TOKEN not set');

const login = await fetch(`${API}/Login/Autenticar?token=${token}`, { method: 'POST', headers: { 'Content-Length': '0' } });
const cookie = login.headers.get('set-cookie')?.match(/apiCredentials=[^;]+/)?.[0];
if ((await login.text()).trim() !== 'true' || !cookie) throw new Error('Olho Vivo login failed');
const snapshot = await (await fetch(`${API}/Posicao`, { headers: { Cookie: cookie } })).json();

const fleet = new Set(JSON.parse(await readFile(join(ROOT, 'data', 'bike-fleet.json'), 'utf8')).prefixes);
const config = JSON.parse(await readFile(CONFIG, 'utf8'));
const configured = new Set(config.lines.map((l) => l.code));

// Line names from the cached GTFS (built by build-data.mjs), else from the bus signs.
const names = new Map();
try {
  const files = unzipSync(new Uint8Array(await readFile(join(ROOT, '.cache', 'sptrans-gtfs.zip'))), {
    filter: (f) => f.name === 'routes.txt',
  });
  for (const line of strFromU8(files['routes.txt']).split('\n').slice(1)) {
    const cols = line.split('","').map((c) => c.replaceAll('"', ''));
    if (cols[0]) names.set(cols[0], cols[3]);
  }
} catch {}

const stats = new Map(); // code -> { rack, total, name }
for (const line of snapshot.l ?? []) {
  const s = stats.get(line.c) ?? { rack: 0, total: 0, name: names.get(line.c) ?? `${line.lt1} – ${line.lt0}` };
  for (const v of line.vs ?? []) {
    s.total++;
    if (fleet.has(String(v.p))) s.rack++;
  }
  stats.set(line.c, s);
}

const regular = (s) => s.rack >= MIN_BUSES && s.rack / s.total >= MIN_SHARE;
const rows = [...stats].filter(([, s]) => s.rack).sort(([, a], [, b]) => b.rack - a.rack);
console.log(`Olho Vivo ${snapshot.hr}: ${rows.reduce((n, [, s]) => n + s.rack, 0)} rack buses on ${rows.length} lines\n`);
for (const [code, s] of rows) {
  const tag = configured.has(code) ? 'configured' : regular(s) ? 'NEW' : 'occasional';
  console.log(`${code.padEnd(9)} ${String(s.rack).padStart(3)}/${String(s.total).padEnd(3)} ${(s.rack / s.total * 100).toFixed(0).padStart(3)}%  ${tag.padEnd(10)} ${s.name}`);
}
const idle = [...configured].filter((c) => !stats.get(c)?.rack);
if (idle.length) console.log(`\nConfigured lines with no rack bus right now: ${idle.join(', ')}`);

if (process.argv.includes('--write')) {
  const added = rows.filter(([code, s]) => !configured.has(code) && regular(s));
  config.lines.push(...added.map(([code, s]) => ({ code, name: s.name })));
  config.lines.sort((a, b) => a.code.localeCompare(b.code));
  await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nAdded ${added.length} line(s) to public/data/bike-buses.json`);
}
