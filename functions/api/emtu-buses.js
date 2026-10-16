// GET /api/emtu-buses — live positions of the EMTU seletivo buses (public/data/emtu-seletivo.json).
//
// The EMTU feed (rest-emtu.noxxonsat.com.br) has served an expired TLS certificate
// since April 2025, which Workers and browsers refuse, so it is read through the
// relay on Cloud Run (relay/, GET /emtu), like Olho Vivo.

import { cachedJson } from '../_lib/cache.js';
import { emtuVehicles } from '../_lib/emtu.js';
// Plain JSON imports: the Pages build's bundler doesn't accept import attributes.
import config from '../../public/data/emtu-seletivo.json';

const TTL = 20;
const CODES = config.lines.map((l) => l.code).join(',');

export async function onRequestGet(context) {
  const { OLHOVIVO_RELAY_URL: relayUrl, OLHOVIVO_RELAY_KEY: relayKey } = context.env;
  if (!(relayUrl && relayKey)) {
    return Response.json({ error: 'OLHOVIVO_RELAY_URL/KEY não configurados' }, { status: 503 });
  }
  return cachedJson(context, TTL, async () => {
    const res = await fetch(`${relayUrl.replace(/\/$/, '')}/emtu?linhas=${CODES}`, { headers: { 'X-Relay-Key': relayKey } });
    if (!res.ok) throw new Error(`relay /emtu: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return { updated: new Date().toISOString(), vehicles: emtuVehicles(await res.json()) };
  });
}
