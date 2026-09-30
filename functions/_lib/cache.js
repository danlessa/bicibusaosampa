// Serves a JSON response from the Cloudflare edge cache for `ttl` seconds,
// computing it with `produce()` on a miss. Upstream APIs get at most one call
// per TTL per edge location, no matter how many people have the map open.

export async function cachedJson(context, ttl, produce) {
  const cache = caches.default;
  const key = new Request(new URL(context.request.url).origin + new URL(context.request.url).pathname);
  const hit = await cache.match(key);
  if (hit) return hit;

  let body, status = 200;
  try {
    body = await produce();
  } catch (err) {
    console.error(err);
    body = { error: String(err.message ?? err) };
    status = 502;
  }
  const res = new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${status === 200 ? ttl : 5}`,
    },
  });
  if (status === 200) context.waitUntil(cache.put(key, res.clone()));
  return res;
}
