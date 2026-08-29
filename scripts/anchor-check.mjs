#!/usr/bin/env node
/**
 * B7 — READ THE ALIGNMENT INPUTS OFF A REAL TAKE.
 *
 * B7's two errors are exactly the two a synthetic rig CANNOT see, and that is
 * the whole reason the task exists:
 *
 *   · a canvas hands over its first frame in ~0 ms, so a rig's video anchor is
 *     never late — a real getDisplayMedia surface took 233 ms in one measured
 *     run, and that lateness is the video half of the bug;
 *   · a synthetic mic is an oscillator with no device buffer, so the platform
 *     reports no input latency and the audio half is structurally zero too.
 *
 * So this drives REAL Chrome against the DEPLOYED build with a REAL microphone
 * and a REAL getDisplayMedia surface (the tab itself, auto-accepted the way the
 * research harness already does it), records a take, and reads the four values
 * back out of the product's own storage. `--use-fake-ui-for-media-stream`
 * answers the SITE permission prompt while keeping the actual device; it is not
 * `--use-fake-device-for-media-stream`, which would substitute a test pattern
 * and answer nothing.
 *
 * THEN IT RELOADS THE PAGE and reads them again, because "persist with the
 * take and survive a reload" is a gate about IndexedDB and not about a variable
 * that happened to still be in scope.
 *
 *   node scripts/anchor-check.mjs
 *   node scripts/anchor-check.mjs --headed --takeMs=10000
 *   node scripts/anchor-check.mjs --url=http://localhost:4173/
 *
 * Exit 0 only when a real take produced anchors and they survived the reload.
 * QA only: this script changes no product code, and the product cannot tell it
 * apart from a user.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9351
const PROD_URL = 'https://inout-kappa.vercel.app/'
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
}

const opts = { url: PROD_URL, takeMs: 8000, headed: false, synthetic: false }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6)
  else if (a.startsWith('--takeMs=')) opts.takeMs = Number(a.slice(9))
  else if (a === '--headed') opts.headed = true
  else if (a === '--synthetic') opts.synthetic = true
}
/**
 * `--synthetic` EXISTS TO PROVE THE VIDEO LANE IS WIRED, AND IT CANNOT PROVE
 * THE NUMBER. A canvas hands over its first frame almost immediately, so
 * `firstFrameDelayMs` reads near zero here BY CONSTRUCTION — which is the exact
 * blindness B7 was written about. Use it to show the field is populated,
 * persisted and reloaded through the real video path; use a real display source
 * (which needs macOS Screen Recording granted to this Chrome, and an automated
 * throwaway profile does not have it) to learn what the number IS.
 */
if (opts.synthetic) {
  opts.url += (opts.url.includes('?') ? '&' : '?') + 'synthetic=1'
}

let bin = process.env.CHROME_BIN
for (const c of CHROME[process.platform] ?? []) if (!bin && existsSync(c)) bin = c
if (!bin) {
  console.error('anchor-check: no Chrome found (set CHROME_BIN)')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'inout-anchor-'))
const report = { url: opts.url, takeMs: opts.takeMs, captureLog: [], gates: {} }
let browser
let exitCode = 1

try {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // The REAL microphone, with the site prompt auto-answered.
    '--use-fake-ui-for-media-stream',
    // A REAL getDisplayMedia surface — this very tab — with no native picker.
    // This is the point of the whole script: the video first-frame delay is
    // zero on a canvas and non-zero here.
    '--auto-accept-this-tab-capture',
    '--auto-select-tab-capture-source-by-title=INOUT',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  args.push(opts.url)
  browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws = null
  for (let i = 0; i < 200 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.startsWith(new URL(opts.url).origin))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
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
      if (text.startsWith('[capture')) report.captureLog.push(text)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Browser.grantPermissions', {
    origin: new URL(opts.url).origin,
    permissions: ['videoCapture', 'audioCapture'],
  }).catch(() => undefined)

  const evaluate = async (expression) =>
    (
      await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    ).result?.value
  const evalJson = async (expression) => {
    const v = await evaluate(expression)
    try {
      return typeof v === 'string' ? JSON.parse(v) : v
    } catch {
      return null
    }
  }

  await sleep(2500)
  report.gates.boots = !!(await evaluate(
    `!!document.querySelector('button[aria-label="Start recording"]')`,
  ))
  if (!report.gates.boots) throw new Error('the app did not reach the capture screen')

  // Screen + mic: the two channels whose anchors this task is about.
  report.chips = await evalJson(`(async () => {
    const want = { Screen: true, Mic: true, Camera: false, 'Tab Audio': false }
    const read = () => Object.fromEntries(
      [...document.querySelectorAll('.chip')].map((c) => [
        (c.querySelector('.chip__label')?.textContent ?? c.textContent ?? '').trim(),
        c.getAttribute('aria-pressed') === 'true' || c.classList.contains('chip--on'),
      ]),
    )
    for (let i = 0; i < 8; i++) {
      const now = read()
      let clicked = false
      for (const [name, on] of Object.entries(want)) {
        const el = [...document.querySelectorAll('.chip')].find((c) =>
          ((c.querySelector('.chip__label')?.textContent ?? c.textContent ?? '').trim()) === name)
        if (el && now[name] !== on && !el.disabled) { el.click(); clicked = true; break }
      }
      if (!clicked) break
      await new Promise((r) => setTimeout(r, 250))
    }
    return JSON.stringify(read())
  })()`)

  await sleep(600)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(opts.takeMs + 4000)
  await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  )
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.editor')`)) break
    await sleep(500)
  }
  report.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
  await sleep(1500)

  /** Read every channel's anchor out of the product's own IndexedDB. */
  const READ_ANCHORS = `(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('inout', 2)
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('recordings').objectStore('recordings').getAll()
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!rec) return JSON.stringify(null)
    return JSON.stringify({
      id: rec.id,
      durationMs: Math.round(rec.durationMs),
      channels: rec.channels.map((c) => ({
        kind: c.kind,
        startOffsetMs: c.startOffsetMs,
        anchor: c.diagnostics?.anchor ?? null,
      })),
    })
  })()`

  report.beforeReload = await evalJson(READ_ANCHORS)

  // THE RELOAD. "Persists" is a claim about storage, not about scope.
  await send('Page.reload', { ignoreCache: false })
  await sleep(4000)
  report.afterReload = await evalJson(READ_ANCHORS)

  report.anchorLogLine = report.captureLog.find((l) => l.includes('B7 anchors')) ?? null

  const chans = report.afterReload?.channels ?? []
  const has = (k) => chans.find((c) => c.kind === k)?.anchor ?? null
  const screen = has('screen')
  const mic = has('mic')
  report.gates.realTake = (report.beforeReload?.durationMs ?? 0) > 1000 && chans.length >= 2
  report.gates.everyChannelHasAnchor =
    chans.length > 0 && chans.every((c) => c.anchor && typeof c.anchor.rawAnchorMs === 'number')
  report.gates.survivedReload =
    JSON.stringify(report.beforeReload?.channels ?? []) ===
      JSON.stringify(report.afterReload?.channels ?? []) && chans.length > 0
  // The video half: a REAL surface must report a first-frame delay at all. A
  // canvas would report ~0 and this gate would be measuring the rig again.
  report.gates.videoFirstFrameDelayPresent = typeof screen?.firstFrameDelayMs === 'number'
  report.syntheticSource = opts.synthetic
  if (opts.synthetic) {
    report.note =
      'SYNTHETIC SOURCE: firstFrameDelayMs is near zero BY CONSTRUCTION (a canvas has no device ' +
      'spin-up). This run proves the video lane is wired, persisted and reloaded — not what the ' +
      'delay is on real hardware.'
  }
  // The audio half: the field must exist even when the platform reports zero —
  // "the platform told us nothing" IS the finding on a Bluetooth take.
  report.gates.audioLatencyReported = typeof mic?.reportedInputLatencyMs === 'number'
  report.gates.anchorLineOnConsole = !!report.anchorLogLine

  console.log(JSON.stringify(report, null, 2))
  const failed = Object.entries(report.gates).filter(([, v]) => !v)
  if (failed.length === 0) {
    console.error('anchor-check: ALL GATES PASS')
    exitCode = 0
  } else {
    console.error(`anchor-check: FAILED — ${failed.map(([k]) => k).join(', ')}`)
  }
} catch (err) {
  console.error('anchor-check:', err instanceof Error ? err.message : String(err))
  console.log(JSON.stringify(report, null, 2))
} finally {
  try {
    browser?.kill('SIGKILL')
  } catch {
    /* already dead */
  }
  rmSync(profile, { recursive: true, force: true })
  process.exit(exitCode)
}
