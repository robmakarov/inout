#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless-Chromium driver for the research harness.
 * Zero dependencies: Node >= 22 (native WebSocket + fetch) + installed Chrome.
 *
 * Launches Chrome headless on a THROWAWAY profile (hygiene: harness runs
 * must not touch a real profile's storage), opens
 * /experimental.html?synthetic=1 from a running `npm run dev` server, invokes
 * window.__exp.run(<experiment>, <args>) over CDP, prints the JSON report to
 * stdout, and tears everything down.
 *
 * Usage:
 *   node src/experimental/tools/cdp-run.mjs <experiment> [jsonArgs] [--port=5199] [--timeout=1800]
 * Examples:
 *   node src/experimental/tools/cdp-run.mjs oracle
 *   node src/experimental/tools/cdp-run.mjs localize '{"recordMs":6000}'
 *   node src/experimental/tools/cdp-run.mjs matrix '{"n":5}' --timeout=3600
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// EPHEMERAL, not fixed: a fixed 9333 cost three runs in one day — an orphaned
// Chrome from any earlier run keeps the port, the new Chrome silently binds
// another interface, and the driver polls the orphan's stale target list until
// it times out ("timed out waiting for Chrome debug target").
const DEBUG_PORT = await new Promise((resolve, reject) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => {
    const addr = s.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    s.close((err) => (err || !port ? reject(err ?? new Error('no port')) : resolve(port)))
  })
  s.on('error', reject)
})

function parseArgs(argv) {
  const positional = []
  let devPort = 5199
  let timeoutSec = 1800
  let headed = false
  let query = ''
  let ua = ''
  let profileDir = ''
  let keepAudio = false
  let refocus = false
  let realThrottling = false
  let captureTitle = 'INOUT'
  for (const a of argv) {
    if (a.startsWith('--port=')) devPort = Number(a.slice(7))
    else if (a.startsWith('--timeout=')) timeoutSec = Number(a.slice(10))
    else if (a.startsWith('--query=')) query = a.slice(8)
    else if (a.startsWith('--ua=')) ua = a.slice(5)
    else if (a.startsWith('--profile=')) profileDir = a.slice(10)
    else if (a === '--headed') headed = true
    else if (a === '--keep-audio') keepAudio = true
    else if (a === '--refocus') refocus = true
    else if (a === '--real-throttling') realThrottling = true
    else if (a.startsWith('--capture-title=')) captureTitle = a.slice(16)
    else positional.push(a)
  }
  const [experiment, jsonArgs] = positional
  if (!experiment) {
    console.error('usage: cdp-run.mjs <experiment> [jsonArgs] [--port=5199] [--timeout=1800] [--headed]')
    process.exit(2)
  }
  return {
    experiment,
    args: jsonArgs ? JSON.parse(jsonArgs) : undefined,
    devPort,
    timeoutSec,
    headed,
    query,
    ua,
    profileDir,
    keepAudio,
    refocus,
    realThrottling,
    captureTitle,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(url))
      if (page) return { wsUrl: page.webSocketDebuggerUrl, targetId: page.id }
    } catch {
      /* chrome not up yet */
    }
    await sleep(250)
  }
  throw new Error('timed out waiting for Chrome debug target')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.onEvent = null
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg.method, msg.params)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

/**
 * WRITE IT ALL, THEN LET THE PROCESS DIE (task G4, 2026-08-29).
 *
 * `finally` here calls `process.exit()` on purpose — the losing arm of the
 * timeout race and the CDP socket both keep the event loop alive, so without it
 * wall time stops equalling experiment time. But stdout to a PIPE is
 * asynchronous in Node, and `process.exit()` discards whatever has not reached
 * the OS yet. On macOS that buffer is 64 KiB.
 *
 * So every report bigger than 65536 bytes was silently cut in half a sentence,
 * and the runner downstream saw `Unterminated string in JSON at position
 * 65536`. THAT IS WHY NOTHING IN THIS REPO IS MEASURED PAST 30 SECONDS: a
 * longer take makes a bigger report, the report was truncated, and the failure
 * looked like a flaky experiment rather than a broken pipe. A 120 s oracle cell
 * fails this way 100 % of the time and had never been run.
 *
 * Awaiting the drain costs nothing and removes the ceiling.
 */
function writeFully(stream, text) {
  return new Promise((resolve) => {
    if (text && !stream.write(text)) stream.once('drain', resolve)
    else resolve()
  })
}

async function main() {
  const {
    experiment,
    args,
    devPort,
    timeoutSec,
    headed,
    query,
    ua,
    profileDir,
    keepAudio,
    refocus,
    realThrottling,
    captureTitle,
  } = parseArgs(process.argv.slice(2))
  // Extra query params reach the page's own knobs (e.g. `quiet=0.05`, the
  // synthetic-audio level used to exercise the loudness rescue).
  const pageUrl = `http://localhost:${devPort}/experimental.html?synthetic=1${query ? `&${query}` : ''}`
  // --profile=<dir> REUSES a profile across runs and keeps it afterwards —
  // built for the O4 cold-start question: a fresh throwaway profile pays the
  // first VideoEncoder's multi-second init, and only a persisted profile can
  // say whether real users pay it once ever or on every browser launch.
  if (profileDir) mkdirSync(profileDir, { recursive: true })
  const profile = profileDir || mkdtempSync(join(tmpdir(), 'inout-oracle-profile-'))
  const deadline = Date.now() + timeoutSec * 1000

  const chrome = spawn(
    CHROME,
    [
      // Headed mode exists because rAF/encoder scheduling differs between
      // headless and headed Chromium; sync measurements should state which
      // environment produced them.
      ...(headed ? ['--window-size=900,700', '--window-position=40,40'] : ['--headless=new']),
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      // --real-throttling: run with PRODUCTION Chrome's background behaviour.
      // The anti-throttling flags exist so rigs survive being backgrounded, but
      // an occlusion/throttling experiment must reproduce what a USER's Chrome
      // does, and these three flags disable exactly the machinery under test.
      ...(realThrottling
        ? []
        : [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
          ]),
      // Auto-accept current-tab capture (testing flags): lets a rig drive the
      // REAL getDisplayMedia path against its own tab with no native picker —
      // the only way to reproduce captured-tab-audio behaviour in a harness.
      '--auto-accept-this-tab-capture',
      `--auto-select-tab-capture-source-by-title=${captureTitle}`,
      // The cross-tab rigs open their captured tab with window.open().
      '--disable-popup-blocking',
      // --keep-audio: the tab-audio rigs need the tab to be genuinely AUDIBLE —
      // a muted-output tab may capture as silence and make the run vacuous.
      ...(keepAudio ? [] : ['--mute-audio']),
      // Memory experiments need a deterministic heap reading: forced GC plus
      // unquantized performance.memory. Harmless for the other runners.
      '--js-flags=--expose-gc',
      '--enable-precise-memory-info',
      // Capability-gate smokes (e.g. the Apple WebKit audio path) need the UA
      // set before the page loads, so it is a launch flag, not a CDP override.
      ...(ua ? [`--user-agent=${ua}`] : []),
      pageUrl,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let chromeErr = ''
  chrome.stderr.on('data', (d) => {
    chromeErr += String(d)
  })

  const cleanup = () => {
    try {
      chrome.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    try {
      // A named profile is the experiment's subject — keep it.
      if (!profileDir) rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  // A failing run must say what the page said: "experiment threw" with no
  // console is a guess factory (2026-08-26: a whole degrade chain was
  // invisible because nothing forwarded the page's own warnings).
  const consoleTail = []
  let refocusTimer = null
  try {
    const { wsUrl, targetId } = await waitForTarget(
      `http://localhost:${devPort}/experimental.html`,
      Date.now() + 20_000,
    )
    // --refocus: keep the experiment page the ACTIVE target. A rig that opens
    // a child tab (tabaudio crossTab) loses focus to it, and getDisplayMedia
    // throws InvalidStateError from an unfocused document; the page cannot
    // reclaim focus itself in headless, but the DevTools activate endpoint can.
    if (refocus) {
      refocusTimer = setInterval(() => {
        fetch(`http://127.0.0.1:${DEBUG_PORT}/json/activate/${targetId}`).catch(() => undefined)
      }, 1000)
    }
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true })
    })
    const cdp = new Cdp(ws)
    cdp.onEvent = (method, params) => {
      if (method !== 'Runtime.consoleAPICalled') return
      const line = (params.args ?? [])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
        .join(' ')
      consoleTail.push(`[${params.type}] ${line}`)
      if (consoleTail.length > 300) consoleTail.shift()
    }
    await cdp.send('Runtime.enable')

    // Wait for the harness module (and __exp) to be ready.
    const readyDeadline = Date.now() + 30_000
    for (;;) {
      const probe = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.__exp',
        returnByValue: true,
      })
      if (probe.result.value === 'object') break
      if (Date.now() > readyDeadline) throw new Error('harness never exposed window.__exp — is `npm run dev` running?')
      await sleep(250)
    }

    const expr = `window.__exp.run(${JSON.stringify(experiment)}, ${JSON.stringify(args ?? null)})`
    const res = await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutSec * 1000,
      }),
      sleep(deadline - Date.now()).then(() => {
        throw new Error(`experiment timed out after ${timeoutSec}s`)
      }),
    ])

    if (res.exceptionDetails) {
      const detail =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown page error'
      throw new Error(`experiment threw in page:\n${detail}`)
    }
    await writeFully(process.stdout, String(res.result.value) + '\n')
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    if (consoleTail.length)
      console.error('--- page console tail ---\n' + consoleTail.slice(-80).join('\n'))
    if (chromeErr) console.error('--- chrome stderr tail ---\n' + chromeErr.slice(-2000))
    await writeFully(process.stderr, '')
    process.exitCode = 1
  } finally {
    if (refocusTimer) clearInterval(refocusTimer)
    cleanup()
    // The losing arm of the timeout race and the CDP socket keep the event
    // loop alive; exit explicitly so wall time == experiment time.
    process.exit(process.exitCode ?? 0)
  }
}

await main()
