// GET /api/buses — live positions of the buses that carry bikes, from SPTrans Olho Vivo.
// Needs the SPTRANS_TOKEN secret (free key from https://www.sptrans.com.br/desenvolvedores/).

import { cachedJson } from '../_lib/cache.js';
import config from '../../public/data/bike-buses.json' with { type: 'json' };

const API = 'https://api.olhovivo.sptrans.com.br/v2.1';
const TTL = 20; // Olho Vivo refreshes positions every ~30–60 s.

const LINES = new Set(config.lines.map((l) => l.code));
const VEHICLES = new Set(config.vehicles.map(String));

// The session cookie survives between requests served by the same isolate.
let credentials = null;

async function login(token) {
  const res = await fetch(`${API}/Login/Autenticar?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });
  const ok = res.ok && (await res.text()).trim() === 'true';
  const cookie = res.headers.get('set-cookie')?.match(/apiCredentials=[^;]+/)?.[0];
  if (!ok || !cookie) throw new Error('Olho Vivo login failed (check SPTRANS_TOKEN)');
  credentials = cookie;
}

async function get(path, token) {
  if (!credentials) await login(token);
  let res = await fetch(`${API}${path}`, { headers: { Cookie: credentials } });
  if (res.status === 401) {
    await login(token);
    res = await fetch(`${API}${path}`, { headers: { Cookie: credentials } });
  }
  if (!res.ok) throw new Error(`Olho Vivo ${path}: HTTP ${res.status}`);
  return res.json();
}

export function selectVehicles(snapshot) {
  const vehicles = [];
  for (const line of snapshot.l ?? []) {
    const listed = LINES.has(line.c);
    for (const v of line.vs ?? []) {
      if (!listed && !VEHICLES.has(String(v.p))) continue;
      vehicles.push({
        prefix: String(v.p),
        line: line.c,
        sentido: line.sl,
        // lt0/lt1 are the line's destination/origin signs in sentido 1.
        to: line.sl === 1 ? line.lt0 : line.lt1,
        from: line.sl === 1 ? line.lt1 : line.lt0,
        lat: v.py,
        lon: v.px,
        at: v.ta,
        accessible: v.a === true,
      });
    }
  }
  return vehicles;
}

export async function onRequestGet(context) {
  const token = context.env.SPTRANS_TOKEN;
  if (!token) {
    return Response.json({ error: 'SPTRANS_TOKEN não configurado' }, { status: 503 });
  }
  return cachedJson(context, TTL, async () => {
    const snapshot = await get('/Posicao', token);
    return { updated: new Date().toISOString(), hr: snapshot.hr, vehicles: selectVehicles(snapshot) };
  });
}
