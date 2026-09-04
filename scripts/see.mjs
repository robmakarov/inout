#!/usr/bin/env node
/**
 * SEE — a picture of any URL from a REAL Chrome, whether or not the in-app
 * Browser pane is visible (2026-09-04).
 *
 * WHY. The Browser pane is hidden whenever Robert is not looking at that
 * session, and Chrome does not composite a hidden page: a pane screenshot
 * times out after 5 s, and the agent then retries, reloads, retries — 113 such
 * calls across 28 sessions, ~4.6M tokens (org's friction tally). The global
 * pane-guard hook (~/.claude/hooks/pane-guard.py) now refuses the pane
 * screenshot while the pane is hidden and points here.
 *
 * WHAT. Launches Chrome through scripts/lib/chrome.mjs — real CDP, throwaway
 * profile (so it never tests an old build through the PWA cache), background
 * throttling OFF so timers run at full rate — opens about:blank, enables the
 * console, navigates, waits for `readyState === 'complete'` plus --wait ms,
 * optionally evaluates one JS EXPRESSION (a promise is awaited; no bare
 * `return`), takes a PNG, and prints one JSON line: final URL, title, the JS
 * value, the last console lines. Headless by default so nothing pops over
 * Robert's work; --headed when the GPU path matters (WebCodecs/WebGPU differ
 * headless — see the note in chrome.mjs).
 *
 *   node scripts/see.mjs                                        # live app, ?synthetic=1
 *   node scripts/see.mjs "https://inout-kappa.vercel.app/?test" --shot=/tmp/test.png
 *   node scripts/see.mjs <url> --js="document.title" --wait=3000
 *   node scripts/see.mjs <url> --size=1280x800 --full --headed
 *
 * Then `Read` the png. Exit 0 on a picture; 1 when Chrome or the page never came up.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, resolveChrome, sleep } from './lib/chrome.mjs'

const opts = {
  url: 'https://inout-kappa.vercel.app/?synthetic=1',
  shot: '/tmp/inout-see.png',
  js: null,
  wait: 1500,
  headed: false,
  full: false,
  width: 900,
  height: 700,
}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--shot=')) opts.shot = a.slice(7)
  else if (a.startsWith('--js=')) opts.js = a.slice(5)
  else if (a.startsWith('--wait=')) opts.wait = Number(a.slice(7))
  else if (a === '--headed') opts.headed = true
  else if (a === '--full') opts.full = true
  else if (a.startsWith('--size=')) {
    const [w, h] = a.slice(7).split('x').map(Number)
    if (w > 0 && h > 0) {
      opts.width = w
      opts.height = h
    }
  } else if (a.startsWith('--')) {
    console.error(`see: unknown flag ${a}`)
    process.exit(1)
  } else opts.url = a
}

const bin = resolveChrome()
if (!bin) {
  console.error('see: no Chrome found (set CHROME_BIN)')
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'inout-see-'))
let session = null
const tStart = Date.now()
const ms = { launch: 0, load: 0, total: 0 }
try {
  // about:blank first (scriptsOff), so the console is being captured before
  // the page's first line rather than from whenever CDP happened to attach.
  session = await launchChromeRetrying({
    bin,
    profile,
    url: opts.url,
    headed: opts.headed,
    scriptsOff: true,
    extraArgs: [`--window-size=${opts.width},${opts.height}`],
  })
  ms.launch = Date.now() - tStart
  const { send, evaluate, consoleLines } = session
  await send('Emulation.setDeviceMetricsOverride', {
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: opts.url })
  const t0 = Date.now()
  let loaded = false
  while (Date.now() - t0 < 20_000) {
    const state = await evaluate(`location.href !== 'about:blank' && document.readyState`, 5_000)
    if (state === 'complete') {
      loaded = true
      break
    }
    await sleep(100)
  }
  if (!loaded) consoleLines.push('see: page did not reach readyState complete in 20 s — shot taken anyway')
  ms.load = Date.now() - t0
  await sleep(opts.wait)
  let js
  if (opts.js) {
    try {
      js = await evaluate(opts.js)
    } catch (err) {
      js = { error: String(err && err.message ? err.message : err) }
    }
  }
  const title = await evaluate('document.title')
  const href = await evaluate('location.href')
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: opts.full })
  writeFileSync(opts.shot, Buffer.from(shot.data, 'base64'))
  ms.total = Date.now() - tStart
  console.log(
    JSON.stringify({
      shot: opts.shot,
      size: `${opts.width}x${opts.height}`,
      url: href,
      title,
      headed: opts.headed,
      loaded,
      ms,
      js,
      consoleErrors: consoleLines.filter((l) => l.startsWith('error:')).length,
      console: consoleLines.slice(-40),
    }),
  )
} catch (err) {
  console.error(`see: ${err && err.message ? err.message : err}`)
  process.exitCode = 1
} finally {
  if (session) session.kill()
  await sleep(200)
  rmSync(profile, { recursive: true, force: true })
}
