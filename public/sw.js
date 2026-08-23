/**
 * INOUT service worker (task P2).
 *
 * Deliberately minimal, because this app's entire value is a live capture
 * pipeline and a worker that gets clever is a worker that breaks it.
 *
 * Rules:
 *  - Only same-origin GET navigations and build assets are touched. Anything
 *    else — POST, cross-origin, range requests, blob:, the Supabase API — is
 *    passed straight through untouched.
 *  - Build assets are content-hashed, so cache-first is safe and is what makes
 *    an offline start possible.
 *  - The document is network-first with a cache fallback, so a deploy is
 *    picked up on the next load rather than pinned forever.
 *  - Nothing here can touch getUserMedia/getDisplayMedia: permissions and
 *    media streams never pass through fetch. The offline test exists to prove
 *    the worker does not get in the way of reaching the capture screen.
 */

const VERSION = 'inout-v1'
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isAsset(url) {
  return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // Range requests are how media elements read a file — never serve those from
  // a cache, a partial response mismatch is a broken player.
  if (req.headers.has('range')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          void caches.open(VERSION).then((c) => c.put('/', copy))
          return res
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    )
    return
  }

  if (!isAsset(url)) return
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(VERSION).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
