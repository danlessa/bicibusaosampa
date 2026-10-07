// Olho Vivo relay. SPTrans blocks requests coming from Cloudflare Workers, so the
// Pages Function (functions/api/buses.js) reads bus positions through this tiny
// service on Cloud Run instead. It logs in with SPTRANS_TOKEN, keeps the /Posicao
// snapshot for a few seconds, and only answers requests carrying RELAY_KEY.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const API = 'https://api.olhovivo.sptrans.com.br/v2.1';
const { SPTRANS_TOKEN, RELAY_KEY, PORT = 8080 } = process.env;
const TTL_MS = 15_000; // Olho Vivo refreshes positions every ~30–60 s.

let cookie = null;
let cache = null; // { at, gzip }
let inflight = null;

async function login() {
  const res = await fetch(`${API}/Login/Autenticar?token=${encodeURIComponent(SPTRANS_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });
  const body = (await res.text()).trim();
  cookie = res.headers.get('set-cookie')?.match(/apiCredentials=[^;]+/)?.[0] ?? null;
  if (!res.ok || body !== 'true' || !cookie) {
    throw new Error(`Olho Vivo login failed: HTTP ${res.status}, ${body.slice(0, 60) || 'empty body'}`);
  }
}

async function fetchPositions() {
  if (!cookie) await login();
  let res = await fetch(`${API}/Posicao`, { headers: { Cookie: cookie } });
  if (res.status === 401) {
    await login();
    res = await fetch(`${API}/Posicao`, { headers: { Cookie: cookie } });
  }
  if (!res.ok) throw new Error(`Olho Vivo /Posicao: HTTP ${res.status}`);
  return gzipSync(Buffer.from(await res.text()));
}

/** Gzipped /Posicao JSON, refreshed at most once per TTL however many callers. */
async function positions() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.gzip;
  inflight ??= fetchPositions()
    .then((gzip) => (cache = { at: Date.now(), gzip }).gzip)
    .finally(() => { inflight = null; });
  return inflight;
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-relay-key'] ?? ''));
  const expected = Buffer.from(RELAY_KEY ?? '');
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://relay');
  if (pathname === '/health') return res.end('ok'); // Cloud Run reserves /healthz
  if (pathname !== '/posicao') return res.writeHead(404).end();
  if (!authorized(req)) return res.writeHead(401).end();
  try {
    const gzip = await positions();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store',
    });
    res.end(gzip);
  } catch (err) {
    console.error(err);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(PORT, () => console.log(`relay listening on ${PORT}`));
