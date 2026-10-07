// GET /api/buses — live positions of the buses with a bike rack, from SPTrans Olho Vivo.
// Buses are picked by prefix from the fleet list (data/bike-fleet.json), wherever they run.
// Needs the SPTRANS_TOKEN secret (free key from https://www.sptrans.com.br/desenvolvedores/).

import { cachedJson } from '../_lib/cache.js';
import { vehicleFilter } from '../_lib/vehicles.js';
// Plain JSON imports: the Pages build's bundler doesn't accept import attributes.
import fleet from '../../data/bike-fleet.json';
import config from '../../public/data/bike-buses.json';

const API = 'https://api.olhovivo.sptrans.com.br/v2.1';
const TTL = 20; // Olho Vivo refreshes positions every ~30–60 s.

const selectVehicles = vehicleFilter(config, fleet.prefixes);

// The session cookie survives between requests served by the same isolate.
let credentials = null;

async function login(token) {
  const res = await fetch(`${API}/Login/Autenticar?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });
  const body = (await res.text()).trim();
  const cookie = res.headers.get('set-cookie')?.match(/apiCredentials=[^;]+/)?.[0];
  if (!res.ok || body !== 'true' || !cookie) {
    // Say what came back: `false` means a rejected token; HTML means we were blocked.
    throw new Error(`Olho Vivo login failed: HTTP ${res.status}, ${body.slice(0, 60) || 'empty body'}${cookie ? '' : ', no cookie'}`);
  }
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
