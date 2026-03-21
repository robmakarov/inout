const SHELL_CACHE = 'inout-shell-v3';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/storage-model.js',
  '/local-store-idb.js',
];

function isShellPath(pathname) {
  return SHELL_FILES.some((p) => p === pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const path = url.pathname;

  /* App shell: try network first so phones with an installed SW don’t stay on an old index/app.js. */
  if (isShellPath(path)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(req);
          if (response && response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(req, response.clone());
          }
          return response;
        } catch (_) {
          const cached = await caches.match(req);
          if (cached) return cached;
          if (path === '/' || path === '/index.html') {
            const fallback = await caches.match('/index.html');
            if (fallback) return fallback;
          }
          return Response.error();
        }
      })()
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => caches.match('/index.html'));
    })
  );
});
