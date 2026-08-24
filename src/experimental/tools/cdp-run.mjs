#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless-Chromium driver for the research harness.
 * Zero dependencies: Node >= 22 (native WebSocket + fetch) + installed Chrome.
 *
 * Launches Chrome headless on a THROWAWAY profile (TD hygiene: harness runs
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = 9333

function parseArgs(argv) {
  const positional = []
  let devPort = 5199
  let timeoutSec = 1800
  let headed = false
  let query = ''
  let ua = ''
  let profileDir = ''
  for (const a of argv) {
    if (a.startsWith('--port=')) devPort = Number(a.slice(7))
    else if (a.startsWith('--timeout=')) timeoutSec = Number(a.slice(10))
    else if (a.startsWith('--query=')) query = a.slice(8)
    else if (a.startsWith('--ua=')) ua = a.slice(5)
    else if (a.startsWith('--profile=')) profileDir = a.slice(10)
    else if (a === '--headed') headed = true
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
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(url))
      if (page) return page.webSocketDebuggerUrl
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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
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

async function main() {
  const { experiment, args, devPort, timeoutSec, headed, query, ua, profileDir } = parseArgs(
    process.argv.slice(2),
  )
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
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
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

  try {
    const wsUrl = await waitForTarget(`http://localhost:${devPort}/experimental.html`, Date.now() + 20_000)
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true })
    })
    const cdp = new Cdp(ws)
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
    process.stdout.write(String(res.result.value) + '\n')
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    if (chromeErr) console.error('--- chrome stderr tail ---\n' + chromeErr.slice(-2000))
    process.exitCode = 1
  } finally {
    cleanup()
    // The losing arm of the timeout race and the CDP socket keep the event
    // loop alive; exit explicitly so wall time == experiment time.
    process.exit(process.exitCode ?? 0)
  }
}

await main()
