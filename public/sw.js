/* GenZ Editor service worker.
 *  - Makes the app installable and usable offline (static shell + hashed assets).
 *  - Receives files from the OS Share sheet (manifest share_target → POST
 *    /share-target), parks them in a cache, and redirects into the app, which
 *    imports them on startup (see bootstrap.ts → importSharedInbox).
 * Never touches cross-origin requests, /api, or non-GET calls other than the share target. */
const STATIC = 'gz-static-v1';
const INBOX = 'gz-share-inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('gz-static-') && k !== STATIC) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function handleShare(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open(INBOX);
    const stamp = Date.now();
    let n = 0;
    const put = (file, name) => cache.put(
      `/__shared/${stamp}-${n++}`,
      new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(name) } }),
    );
    const files = form.getAll('files').filter((f) => typeof f === 'object' && 'name' in f);
    for (const f of files) await put(f, f.name || 'shared-file');
    if (!files.length) {
      // Shared text / link (e.g. from a browser or notes app) → a text file.
      const title = String(form.get('title') || '').trim();
      const body = [form.get('text'), form.get('url')].filter(Boolean).join('\n');
      if (body) await put(new Blob([body], { type: 'text/plain' }), `${(title || 'Shared text').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.txt`);
    }
  } catch (err) {
    // Fall through to the app; it just won't find anything to import.
  }
  return Response.redirect(new URL('/?shared=1', req.url).toString(), 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname === '/share-target') {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // Network first so a fresh deploy always wins; fall back to the cached shell offline.
    const key = new Request(url.origin + url.pathname);
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') (await caches.open(STATIC)).put(key, res.clone());
        return res;
      } catch (err) {
        return (await caches.match(key)) || (await caches.match(new Request(url.origin + '/'))) || Response.error();
      }
    })());
    return;
  }

  // Hashed build assets never change → cache first. Other static files: stale-while-revalidate.
  const hashed = url.pathname.startsWith('/assets/');
  e.respondWith((async () => {
    const cache = await caches.open(STATIC);
    const hit = await cache.match(req);
    if (hit && hashed) return hit;
    const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; });
    if (hit) { net.catch(() => {}); return hit; }
    return net;
  })());
});
