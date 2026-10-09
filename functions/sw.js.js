// GET /sw.js — the PWA service worker (public/sw-template.js), stamped with the
// deployed commit. A new deploy changes the commit, so the browser sees a new worker
// byte-for-byte, installs it and the page offers a reload (public/js/ui.js). No version
// to bump by hand. Locally (no commit) the version is "dev" and the worker caches nothing.

export async function onRequestGet(context) {
  const version = context.env.CF_PAGES_COMMIT_SHA?.slice(0, 12) || 'dev';
  const template = await context.env.ASSETS.fetch(new URL('/sw-template.js', context.request.url));
  if (!template.ok) return new Response('service worker unavailable', { status: 502 });
  const source = (await template.text()).replace("'__VERSION__'", JSON.stringify(version));
  return new Response(source, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  });
}
