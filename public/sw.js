// Service Worker: macht die App installierbar und offline startbar.
// Seitenaufrufe: erst Netz, bei Fehler Cache. Übrige Dateien: Cache, im Hintergrund auffrischen.

const CACHE = 'wuerfel-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/ws')) return;
  if (url.pathname === '/version.json') return; // Versionsprüfung immer direkt vom Server

  const put = (res) => {
    if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
    return res;
  };

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(put)
        .catch(() => caches.match(req).then((r) => r || caches.match('/'))),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then(put);
      return hit || fresh;
    }),
  );
});
