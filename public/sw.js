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
 *  - AND THE WHOLE BUILD IS CACHED UP FRONT (task B3). Cache-first only helps
 *    an asset the cache HAS. The lazy chunks — the export worker, the size
 *    probe, EditorScreen, session — are by definition the ones a tab has not
 *    asked for, so they were never in it; when such a tab spanned a deploy the
 *    cache missed, the network had moved on, and the host served 404. Measured
 *    in scripts/stale-tab-check.mjs: SEVEN of a build's assets 404 in an open
 *    tab after the next deploy, the tab cannot even reach the editor, and the
 *    export falls back to the in-thread render (7.5 s of an 8.2 s render in
 *    encode-wait, on Robert's own console). The build's own manifest —
 *    /asset-manifest.json, emitted by vite.config.ts — is the list.
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

/**
 * Cache every asset of the build that is asking, skipping what is already
 * there (task B3).
 *
 * ONE AT A TIME, NOT `cache.addAll`: addAll is atomic, so a single asset the
 * host has already replaced would throw away the other twenty-three — and a
 * deploy landing mid-precache is exactly the situation this exists for. A
 * partial precache is strictly better than none.
 *
 * `cache: 'no-store'` on the manifest because it is not content-hashed: the
 * whole point is to read the list the CURRENT page was served with.
 */
/**
 * How many builds' assets are kept. Caching the whole build costs ~1 MB per
 * DISTINCT build a user loads, and this repo deploys many times a day — without
 * a bound, a month of Robert's own QA would leave tens of MB behind. Three is
 * chosen so a tab has to survive THREE deploys before it loses its chunks;
 * before B3 no tab survived one.
 */
const KEEP_BUILDS = 3
/** Cache key holding the last few manifests. Not a real request; never fetched. */
const HISTORY_KEY = '/__inout-build-history'

async function precacheBuild() {
  const cache = await caches.open(VERSION)
  let manifest
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-store' })
    if (!res.ok) return { ok: false, cached: 0, reason: `manifest ${res.status}` }
    manifest = await res.json()
  } catch (err) {
    return { ok: false, cached: 0, reason: String(err) }
  }
  const assets = Array.isArray(manifest && manifest.assets) ? manifest.assets : []
  if (assets.length === 0) return { ok: false, cached: 0, reason: 'empty manifest' }
  let cached = 0
  let missed = 0
  for (const path of assets) {
    try {
      if (await cache.match(path)) continue
      const res = await fetch(path)
      if (!res.ok) {
        missed++
        continue
      }
      await cache.put(path, res)
      cached++
    } catch {
      missed++
    }
  }
  const pruned = await pruneToRecentBuilds(cache, assets)
  return { ok: true, cached, missed, total: assets.length, pruned }
}

/**
 * Keep this build and the previous KEEP_BUILDS-1, drop the rest.
 *
 * THE ORDER MATTERS AND IT IS THE WHOLE RISK: the current build's list is
 * recorded FIRST and everything kept is the union of the retained lists, so the
 * build a tab is running can never be the thing that gets deleted. Deleting the
 * running build's chunks would recreate the exact bug this file is fixing, only
 * with our own hand.
 */
async function pruneToRecentBuilds(cache, assets) {
  let history = []
  try {
    const hit = await cache.match(HISTORY_KEY)
    if (hit) history = await hit.json()
  } catch {
    history = []
  }
  if (!Array.isArray(history)) history = []
  const signature = assets.join(',')
  history = history.filter((h) => Array.isArray(h) && h.join(',') !== signature)
  history.unshift(assets)
  history = history.slice(0, KEEP_BUILDS)
  await cache.put(HISTORY_KEY, new Response(JSON.stringify(history), {
    headers: { 'content-type': 'application/json' },
  }))
  const keep = new Set(history.flat())
  let pruned = 0
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname
    if (!path.startsWith('/assets/') || keep.has(path)) continue
    if (await cache.delete(req)) pruned++
  }
  return pruned
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => precacheBuild())
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

/**
 * THE PAGE ASKS FOR ITS OWN BUILD TO BE CACHED, ON EVERY LOAD.
 *
 * `install` runs once. This file's bytes do not change between deploys, so the
 * worker never reinstalls and would otherwise precache exactly one build ever —
 * the first one a user ever saw. Every later build would be back to caching
 * only what it happened to fetch, which is the bug. So the page tells the
 * worker, after each load, to make sure ITS build is complete in the cache.
 * Idempotent and cheap: everything already cached is skipped.
 */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'inout-precache-build') return
  const reply = (msg) => {
    if (event.source && event.source.postMessage) event.source.postMessage(msg)
  }
  event.waitUntil(
    precacheBuild().then(
      (r) => reply({ type: 'inout-precache-done', ...r }),
      (err) => reply({ type: 'inout-precache-done', ok: false, reason: String(err) }),
    ),
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
