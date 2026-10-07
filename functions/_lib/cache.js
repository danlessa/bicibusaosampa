// Serves a JSON response from the Cloudflare edge cache, computing it with
// `produce()` at most once per `ttl` seconds per edge location.
//
// Stale-while-revalidate: once an answer is older than `ttl`, the next request
// still gets it immediately while a fresh one is fetched in the background, so
// visitors never wait on the upstream API unless the cache is empty or the
// answer is more than STALE_FOR seconds past its `ttl`.

const STALE_FOR = 300;
const FETCHED_AT = 'X-Fetched-At';

// Refreshes already running in this isolate, by cache key.
const inflight = new Map();

function forClient(res, maxAge) {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${maxAge}`);
  out.headers.delete(FETCHED_AT);
  return out;
}

const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };

// Resolves to the JSON text (not a Response, which can't be shared between requests).
async function refresh(context, key, produce, ttl) {
  const text = JSON.stringify(await produce());
  const stored = new Response(text, {
    headers: { ...JSON_TYPE, 'Cache-Control': `public, max-age=${ttl + STALE_FOR}`, [FETCHED_AT]: String(Date.now()) },
  });
  context.waitUntil(caches.default.put(key, stored));
  return text;
}

function refreshOnce(context, key, produce, ttl) {
  if (!inflight.has(key.url)) {
    const p = refresh(context, key, produce, ttl).finally(() => inflight.delete(key.url));
    inflight.set(key.url, p);
  }
  return inflight.get(key.url);
}

export async function cachedJson(context, ttl, produce) {
  const url = new URL(context.request.url);
  const key = new Request(url.origin + url.pathname + url.search);
  const hit = await caches.default.match(key);
  const age = hit ? (Date.now() - Number(hit.headers.get(FETCHED_AT))) / 1000 : Infinity;

  if (hit && age < ttl) return forClient(hit, Math.max(1, Math.round(ttl - age)));
  if (hit) {
    context.waitUntil(refreshOnce(context, key, produce, ttl).catch((err) => console.error(err)));
    return forClient(hit, 1);
  }
  try {
    const text = await refreshOnce(context, key, produce, ttl);
    return new Response(text, { headers: { ...JSON_TYPE, 'Cache-Control': `public, max-age=${ttl}` } });
  } catch (err) {
    console.error(err);
    return Response.json({ error: String(err.message ?? err) }, { status: 502, headers: { 'Cache-Control': 'public, max-age=5' } });
  }
}
