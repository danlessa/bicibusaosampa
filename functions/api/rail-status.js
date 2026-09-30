// GET /api/rail-status — live operational status of metro/train lines.
// Source: the status feed behind trilhos.motiva.com.br, which aggregates Metrô,
// CPTM, TIC Trens, Trivia and the Motiva concessions. It only answers
// server-side requests (no CORS), hence this proxy.

import { cachedJson } from '../_lib/cache.js';

const FEED = 'https://webapi.grupoccr.com.br/v1/mobility/public/line-status/current/state/SP';
const TTL = 60;

export function normalize(feed) {
  const lines = {};
  for (const concession of feed?.data?.concessoes ?? []) {
    for (const line of concession.linhas ?? []) {
      const s = line.statusLinha ?? {};
      lines[String(line.numero)] = {
        code: s.codigo ?? null,
        status: s.status ?? null,
        description: s.descricao && s.descricao !== s.status ? s.descricao : null,
      };
    }
  }
  return { updated: feed?.data?.dataAtualizacao ?? null, lines };
}

export async function onRequestGet(context) {
  return cachedJson(context, TTL, async () => {
    const res = await fetch(FEED, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`status feed: HTTP ${res.status}`);
    return normalize(await res.json());
  });
}
