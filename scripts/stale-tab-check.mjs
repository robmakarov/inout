#!/usr/bin/env node
/**
 * B3 — DOES A TAB THAT SPANS A DEPLOY STILL WORK?
 *
 * From Robert's own console on real takes against the deployed build:
 * `/assets/sizeProbe-*.js` 404, `index-*.css` 404, and twice
 * `[compose] export worker unusable, rendering in-thread`. The fallback worked,
 * so files were delivered — on the slow lane, on the UI thread: one 32 s take
 * spent 7.5 s of its 8.2 s render in encode-wait.
 *
 * THE MECHANISM, and it is not "the cache is stale". The service worker is
 * cache-first for /assets/, so an asset it has ALREADY SEEN survives a deploy
 * fine. The ones that break are the LAZY chunks a session has not opened yet —
 * the export worker, the size probe, a route's CSS. They were never fetched, so
 * they are not in the cache; when the panel finally opens, the SW misses, goes
 * to the network, and the network has moved on to build N+1. Cache-first is not
 * the bug; an INCOMPLETE cache is.
 *
 * (The same hole makes the PWA's offline promise thinner than it looks: the
 * install-time precache list is `/` and the icons — not one line of JS.)
 *
 * THE REPRO, end to end, no deploy required:
 *   1. build A, serve it, open the app, let the service worker install;
 *   2. build B with different hashes, and swap the served directory — this is
 *      exactly what Vercel does to a tab that is already open;
 *   3. in the SAME tab, ask for build A's assets and record a take through to
 *      an export.
 * Before the fix, step 3 404s and the export falls back in-thread. After it,
 * every asset comes from the cache and the worker is used.
 *
 *   node scripts/stale-tab-check.mjs
 *   node scripts/stale-tab-check.mjs --headed
 *
 * Exit 0 only when a tab that spanned a deploy still loads every asset AND
 * still exports in the worker.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9353
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

const opts = { headed: false, takeMs: 4000, broken: false }
for (const a of process.argv.slice(2)) {
  if (a === '--headed') opts.headed = true
  else if (a === '--broken') opts.broken = true
  else if (a.startsWith('--takeMs=')) opts.takeMs = Number(a.slice(9))
}
/**
 * `--broken` IS HOW THIS GATE IS PROVED RED (note 17). It withholds
 * /asset-manifest.json, so the worker has no list and falls back to caching
 * only what the tab happened to fetch — which is exactly the behaviour before
 * B3. Expect: seven assets 404, the tab cannot reach the editor, no export.
 */

let bin = process.env.CHROME_BIN
for (const c of CHROME[process.platform] ?? []) if (!bin && existsSync(c)) bin = c
if (!bin) {
  console.error('stale-tab-check: no Chrome found (set CHROME_BIN)')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'inout-stale-'))
const dirA = join(work, 'A')
const dirB = join(work, 'B')
const profile = join(work, 'profile')
const report = { assetsA: [], assetsB: [], gates: {}, notFound: [], captureLog: [], consoleErrors: [] }
let served = dirA
let browser
let server
let exitCode = 1

/**
 * Build into `out` with `stamp` written into the sources, so the content hashes
 * differ the way a real deploy's do.
 *
 * The stamp goes into an ENTRY file and into two LAZY ones on purpose: a deploy
 * that only moved the entry hash would not reproduce this bug at all, because
 * the entry is already in the tab. The chunks that break are the ones the tab
 * has not asked for yet, and `sizeProbe` / `export.worker` are the two Robert's
 * console named.
 */
const STAMPED = ['src/main.tsx', 'src/core/compose/sizeProbe.ts', 'src/core/compose/export.worker.ts']

function build(out, stamp) {
  const originals = STAMPED.map((f) => [join(ROOT, f), readFileSync(join(ROOT, f), 'utf8')])
  try {
    for (const [file, text] of originals) {
      // A COMMENT DOES NOT WORK — minification strips it and both builds hash
      // identically, which the first version of this script proved by
      // reporting "the deploy did not change anything". It has to be a side
      // effect rollup may not remove.
      writeFileSync(file, `${text}\nglobalThis.__INOUT_BUILD_STAMP__ = ${JSON.stringify(stamp)}\n`)
    }
    execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
      cwd: ROOT,
      stdio: 'pipe',
    })
  } finally {
    for (const [file, text] of originals) writeFileSync(file, text)
  }
  return readdirSync(join(out, 'assets')).map((f) => `/assets/${f}`)
}

try {
  console.error('stale-tab-check: building A…')
  report.assetsA = build(dirA, 'stale-check-A')
  console.error(`stale-tab-check: A has ${report.assetsA.length} assets`)

  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (opts.broken && url.pathname === '/asset-manifest.json') {
      res.writeHead(404).end('not found')
      return
    }
    let p = join(served, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (!existsSync(p) || statSync(p).isDirectory()) {
      // A deployed host serves index.html for unknown ROUTES and 404s for
      // unknown ASSETS. Reproducing both matters: the whole bug is an asset
      // 404 that a SPA fallback would have hidden behind an HTML body.
      if (url.pathname.startsWith('/assets/')) {
        report.notFound.push(url.pathname)
        res.writeHead(404).end('not found')
        return
      }
      p = join(served, 'index.html')
    }
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
    createReadStream(p).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = `http://localhost:${port}/?synthetic=1`
  console.error(`stale-tab-check: serving build A on ${url}`)

  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--mute-audio',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  args.push(url)
  browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws = null
  for (let i = 0; i < 200 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.includes(`:${port}`))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {
      /* not up */
    }
    if (!ws) await sleep(200)
  }
  if (!ws) throw new Error('Chrome never exposed a debuggable page')

  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp connect failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (m.params.type === 'error') report.consoleErrors.push(text)
      if (text.startsWith('[capture') || text.startsWith('[compose') || text.startsWith('[pwa'))
        report.captureLog.push(text)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.value

  // ---- 1. let the worker install and take control -------------------------
  let controlled = false
  for (let i = 0; i < 60 && !controlled; i++) {
    await sleep(500)
    controlled = !!(await evaluate(`!!navigator.serviceWorker.controller`))
  }
  report.gates.serviceWorkerControls = controlled
  if (!controlled) throw new Error('the service worker never took control of the page')
  // Give any precache pass time to finish before the deploy lands.
  await sleep(2500)
  report.cachedBeforeDeploy = await evaluate(`(async () => {
    const names = await caches.keys()
    let n = 0
    for (const k of names) n += (await (await caches.open(k)).keys()).length
    return n
  })()`)

  // ---- 2. THE DEPLOY ------------------------------------------------------
  console.error('stale-tab-check: building B (the deploy)…')
  report.assetsB = build(dirB, 'stale-check-B')
  served = dirB
  const gone = report.assetsA.filter((a) => !report.assetsB.includes(a))
  report.assetsReplaced = gone.length
  console.error(`stale-tab-check: deployed B — ${gone.length} of A's assets no longer exist`)
  if (gone.length === 0) throw new Error('build B reused every hash — the deploy did not change anything')

  // ---- 3. can the OPEN TAB still get build A's assets? ---------------------
  report.assetFetches = await evaluate(`(async () => {
    const out = []
    for (const a of ${JSON.stringify(gone)}) {
      try {
        const r = await fetch(a)
        out.push({ a, status: r.status, type: r.type })
      } catch (e) {
        out.push({ a, status: 0, error: String(e) })
      }
    }
    return out
  })()`)
  const bad = (report.assetFetches ?? []).filter((f) => f.status !== 200)
  report.assetsMissingAfterDeploy = bad
  report.gates.everyAssetStillReachable = bad.length === 0

  // ---- 4. and does the export still run in the WORKER? --------------------
  await evaluate(`document.querySelector('button[aria-label="Start recording"]')?.click()`)
  await sleep(opts.takeMs + 3000)
  await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  )
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.editor')`)) break
    await sleep(500)
  }
  report.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
  await sleep(1200)
  await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(1200)
  await evaluate(
    `(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`,
  )
  let meta = null
  for (let i = 0; i < 180 && !meta; i++) {
    await sleep(500)
    meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
  }
  report.exportMeta = meta
  report.gates.exported = !!meta
  report.workerFallbackLines = report.captureLog.filter((l) => l.includes('export worker unusable'))
  // THE GATE THE TASK NAMES: not merely "it exported", but that it did NOT take
  // the in-thread fallback. That fallback works, which is precisely why this
  // bug survived — it has to be asserted absent.
  // ANTI-VACUITY: this can only be evidence if an export actually ran. In the
  // `--broken` run nothing exported (the tab could not even reach the editor),
  // and the fallback line was therefore absent — which the first version of
  // this gate scored as PASS, next to four failures. A gate that reads green
  // because its subject never happened is the thing the G lane just spent a
  // night removing.
  report.gates.exportWorkerNotBypassed =
    report.gates.exported && report.workerFallbackLines.length === 0
  report.gates.noAssetNotFound = report.notFound.length === 0

  // ---- 5. THE CONTROL: a FRESH tab on the new build is unchanged ----------
  // A fix that repaired the stale tab by pinning everyone to an old build
  // would pass every gate above and be much worse than the bug. So a brand-new
  // tab is opened against build B and must load build B — not A — and boot.
  const fresh = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    })
  ).json()
  const fws = new WebSocket(fresh.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    fws.addEventListener('open', r, { once: true })
    fws.addEventListener('error', () => j(new Error('fresh tab cdp connect failed')), { once: true })
  })
  let fseq = 0
  const fpending = new Map()
  fws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && fpending.has(m.id)) {
      const { resolve, reject } = fpending.get(m.id)
      fpending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  })
  const fsend = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++fseq
      fpending.set(id, { resolve, reject })
      fws.send(JSON.stringify({ id, method, params }))
    })
  await fsend('Runtime.enable')
  const fevaluate = async (expression) =>
    (await fsend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))
      .result?.value
  // EITHER surface counts as booted. The tab that ran the take above leaves a
  // recording behind, and the app restores the most recent one — so a fresh tab
  // opened right after it lands in the EDITOR, not on the capture screen. The
  // first version of this gate demanded the record button and reported a
  // perfectly healthy app as broken.
  let freshBoots = false
  for (let i = 0; i < 40 && !freshBoots; i++) {
    await sleep(500)
    freshBoots = !!(await fevaluate(
      `!!(document.querySelector('button[aria-label="Start recording"]') || document.querySelector('.editor'))`,
    ))
  }
  report.freshTabDom = await fevaluate(
    `JSON.stringify({ root: !!document.querySelector('#root')?.children.length, editor: !!document.querySelector('.editor'), record: !!document.querySelector('button[aria-label="Start recording"]'), buttons: [...document.querySelectorAll('button')].slice(0,8).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()) })`,
  )
  report.gates.freshTabBoots = freshBoots
  // …and it is running build B's entry, not a cached A.
  report.freshTabScripts = await fevaluate(
    `JSON.stringify([...document.querySelectorAll('script[src],link[href]')].map(e => e.src || e.href).filter(u => u.includes('/assets/')).map(u => new URL(u).pathname))`,
  )
  const freshList = JSON.parse(report.freshTabScripts ?? '[]')
  report.gates.freshTabServedNewBuild =
    freshList.length > 0 && freshList.every((p) => report.assetsB.includes(p))

  // ---- 6. RETENTION: the running build was not the thing we deleted -------
  // The prune keeps the last KEEP_BUILDS manifests and drops the rest, and the
  // one way it could be catastrophic is by deleting the build a tab is running.
  // READ AFTER THE FRESH TAB, and that ordering IS the correction: the history
  // gains a build only when a PAGE OF THAT BUILD loads and asks. Read before
  // it, the history holds one entry — build A — which is correct, and which an
  // earlier version of this gate scored as a failure.
  // (The prune threshold is crossed only by a fourth distinct build; what is
  // asserted here is that nothing is dropped before it should be.)
  await sleep(3000)
  report.cacheState = await evaluate(`(async () => {
    const c = await caches.open('inout-v1')
    const hit = await c.match('/__inout-build-history')
    const history = hit ? await hit.json() : null
    const keys = (await c.keys()).map((r) => new URL(r.url).pathname)
    return JSON.stringify({
      historyBuilds: Array.isArray(history) ? history.length : 0,
      cachedAssets: keys.filter((k) => k.startsWith('/assets/')).length,
      keys,
    })
  })()`)
  const cacheState = JSON.parse(report.cacheState ?? '{}')
  report.gates.historyKeptBothBuilds = cacheState.historyBuilds === 2
  report.gates.runningBuildStillCached = (report.assetsA ?? []).every((a) =>
    (cacheState.keys ?? []).includes(a),
  )
  report.gates.newBuildAlsoCached = (report.assetsB ?? []).every((a) =>
    (cacheState.keys ?? []).includes(a),
  )

  console.log(JSON.stringify(report, null, 2))
  const failed = Object.entries(report.gates).filter(([, v]) => !v)
  if (failed.length === 0) {
    console.error('stale-tab-check: ALL GATES PASS')
    exitCode = 0
  } else {
    console.error(`stale-tab-check: FAILED — ${failed.map(([k]) => k).join(', ')}`)
  }
} catch (err) {
  console.error('stale-tab-check:', err instanceof Error ? err.message : String(err))
  console.log(JSON.stringify(report, null, 2))
} finally {
  try {
    browser?.kill('SIGKILL')
  } catch {
    /* already dead */
  }
  server?.close()
  rmSync(work, { recursive: true, force: true })
  process.exit(exitCode)
}
