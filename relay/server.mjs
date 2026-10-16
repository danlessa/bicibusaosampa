// Olho Vivo relay. SPTrans blocks requests coming from Cloudflare Workers, so the
// Pages Function (functions/api/buses.js) reads bus positions through this tiny
// service on Cloud Run instead. It logs in with SPTRANS_TOKEN, keeps the /Posicao
// snapshot for a few seconds, and only answers requests carrying RELAY_KEY.
//
// It also relays the EMTU seletivo buses (GET /emtu, for functions/api/emtu-buses.js):
// their feed's TLS certificate has expired, which Workers refuse.

import { createServer } from 'node:http';
import { request } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
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

// ---------------------------------------------------------------- EMTU

const EMTU_HOST = 'rest-emtu.noxxonsat.com.br';
const EMTU_LINE = /^[0-9A-Z]{1,8}$/;
const EMTU_MAX_LINES = 40;
const emtuCache = new Map(); // sorted codes -> { at, gzip } | { inflight }

/**
 * GET from the EMTU feed. Its certificate expired in April 2025: that one error is
 * accepted, for this host only. The chain and the host name are still checked.
 */
function emtuGet(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: EMTU_HOST, path, agent: false, rejectUnauthorized: false, timeout: 20_000, headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`EMTU ${path}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
      });
    });
    // A fresh connection per request (agent: false), so every one goes through this check.
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const err = socket.authorized ? null
        : socket.authorizationError !== 'CERT_HAS_EXPIRED' ? new Error(`EMTU TLS: ${socket.authorizationError}`)
        : checkServerIdentity(EMTU_HOST, socket.getPeerCertificate());
      if (err) req.destroy(err);
    }));
    req.on('timeout', () => req.destroy(new Error(`EMTU ${path}: timeout`)));
    req.on('error', reject);
    req.end();
  });
}

/** Vehicles and direction names of each line; a line that fails is just left out. */
async function fetchEmtu(codes) {
  const results = await Promise.allSettled(codes.map((c) => emtuGet(`/rest/lineDetails?linha=${encodeURIComponent(c)}`)));
  const linhas = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') return console.error(`EMTU ${codes[i]}: ${r.reason?.message ?? r.reason}`);
    for (const l of r.value.linhas ?? []) {
      linhas.push({
        codigo: l.codigo,
        rotas: (l.rotas ?? []).map(({ sentido, cidade, destino }) => ({ sentido, cidade, destino })),
        veiculos: l.veiculos ?? [],
      });
    }
  });
  if (!linhas.length) throw new Error('EMTU: no line answered');
  return gzipSync(Buffer.from(JSON.stringify({ linhas })));
}

async function emtu(codes) {
  const key = codes.join(',');
  const hit = emtuCache.get(key);
  if (hit?.gzip && Date.now() - hit.at < TTL_MS) return hit.gzip;
  if (hit?.inflight) return hit.inflight;
  const inflight = fetchEmtu(codes)
    .then((gzip) => { emtuCache.set(key, { at: Date.now(), gzip }); return gzip; })
    .catch((err) => { if (hit?.gzip) emtuCache.set(key, hit); else emtuCache.delete(key); throw err; });
  emtuCache.set(key, { ...hit, inflight });
  return inflight;
}

// ---------------------------------------------------------------- server

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-relay-key'] ?? ''));
  const expected = Buffer.from(RELAY_KEY ?? '');
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://relay');
  if (pathname === '/health') return res.end('ok'); // Cloud Run reserves /healthz
  if (pathname !== '/posicao' && pathname !== '/emtu') return res.writeHead(404).end();
  if (!authorized(req)) return res.writeHead(401).end();
  let codes = [];
  if (pathname === '/emtu') {
    codes = [...new Set((searchParams.get('linhas') ?? '').toUpperCase().split(',').filter(Boolean))].sort();
    if (!codes.length || codes.length > EMTU_MAX_LINES || !codes.every((c) => EMTU_LINE.test(c))) {
      return res.writeHead(400).end();
    }
  }
  try {
    const gzip = pathname === '/emtu' ? await emtu(codes) : await positions();
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
