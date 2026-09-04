#!/usr/bin/env node
/**
 * SAFARI — run one script inside Robert's REAL Safari and print what it returns
 * (2026-09-04, task P9).
 *
 * WHY. Three tasks were blocked on "we cannot see Safari": P9's frame-source
 * seam could not prove its WebKit rung, P8's mic defect was waiting on an
 * exported file from Robert, and P1's browser breadth had no third engine. The
 * assumed unblock was `npx playwright install webkit` — but Playwright's WebKit
 * is NOT Safari (no hardware-codec parity, different media stack), which is why
 * the P9 row says real-Safari proof stays an artifact. safaridriver drives the
 * actual browser, on the actual machine, with the actual codecs.
 *
 * ONE-TIME SETUP, ROBERT'S AND ALREADY DONE: Safari → Settings → Developer →
 * "Allow remote automation". If a run says it is off, that checkbox is why, and
 * safaridriver must be restarted AFTER it is ticked (it caches the answer).
 *
 *   node scripts/safari.mjs <url> <script.js>
 *   node scripts/safari.mjs "https://inout-kappa.vercel.app/?synthetic=1" probe.js
 *
 * The script file is run with `execute/async`: its last argument is `done`, and
 * whatever it passes to `done` is printed as JSON. Write it as
 *
 *   const done = arguments[arguments.length - 1]
 *   ;(async () => { ... ; done(result) })()
 *
 * WHAT IT CANNOT DO. getDisplayMedia and getUserMedia open native pickers and
 * permission sheets that WebDriver cannot click, so a REAL screen or camera
 * take still needs Robert's hands. `?synthetic=1` needs neither and is enough
 * for every capability question — it is how the WebKit rung was measured.
 *
 * MEASURED THROUGH THIS, Safari 26.6, 2026-09-04 (see .ai/TASKS P9):
 *   main thread MediaStreamTrackProcessor  NO   ·  worker  YES
 *   MediaStreamTrack transfer to a worker  YES  ·  74 frames read off a
 *   transferred clone in 2.5 s while the original's MediaRecorder kept writing
 *   WebCodecs / WebGPU / OPFS SyncAccessHandle in the worker: all present, <60 ms
 *   <video> readyState>=2 in 35 ms (Chromium: 4903 ms)
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.SAFARIDRIVER_PORT ?? 4599)
const BASE = `http://localhost:${PORT}`

const url = process.argv[2]
const jsPath = process.argv[3]
if (!url || !jsPath) {
  console.error('usage: node scripts/safari.mjs <url> <script.js>')
  process.exit(2)
}
const script = readFileSync(jsPath, 'utf8')

async function wd(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.value?.message ?? JSON.stringify(json)
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`)
  }
  return json.value
}

async function driverReady() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

let started = null
if (!(await driverReady())) {
  // A driver started BEFORE "Allow remote automation" was ticked keeps saying
  // no, so this always starts a fresh one rather than trusting an old process.
  started = spawn('/usr/bin/safaridriver', ['-p', String(PORT)], { stdio: 'ignore', detached: true })
  started.unref()
  for (let i = 0; i < 20 && !(await driverReady()); i++) await new Promise((r) => setTimeout(r, 250))
  if (!(await driverReady())) {
    console.error(`safari: safaridriver did not come up on ${PORT}`)
    process.exit(1)
  }
}

let sessionId = null
try {
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } })
  sessionId = s.sessionId
  await wd('POST', `/session/${sessionId}/url`, { url })
  await wd('POST', `/session/${sessionId}/timeouts`, { script: 120000 })
  const value = await wd('POST', `/session/${sessionId}/execute/async`, { script, args: [] })
  console.log(JSON.stringify(value, null, 2))
} catch (err) {
  console.error('safari:', err.message)
  if (/remote automation/i.test(err.message)) {
    console.error('safari: tick Safari → Settings → Developer → "Allow remote automation", then run again (this script restarts the driver itself).')
  }
  process.exitCode = 1
} finally {
  if (sessionId) await wd('DELETE', `/session/${sessionId}`).catch(() => {})
}
