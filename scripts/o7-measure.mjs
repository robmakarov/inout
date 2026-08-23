#!/usr/bin/env node
/**
 * O7 evidence: first-paint payload, record-click latency, and editor-chunk
 * prefetch — measured on the PRODUCTION BUILD, served by `vite preview`.
 *
 * The dev server is useless for this: it serves unbundled modules, so chunking
 * and request counts there mean nothing. Project rule is also explicit — QA on
 * the prod build port only, never the dev server.
 *
 * Reports:
 *   initialJsBytes   — scripts the document itself loads (the gate: <= 300 KB)
 *   armingMs         — record click -> "recording" from the app's own logs
 *   editorChunkMs    — record click -> editor chunk fetched (must be < take)
 *   recordPathWaterfall — requests fired between click and recording start
 *
 * Usage: node scripts/o7-measure.mjs [--takeMs=10000] [--headed]
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = 9337
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  let takeMs = 10_000
  let headed = false
  for (const a of argv) {
    if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
    else if (a === '--headed') headed = true
  }
  return { takeMs, headed }
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, 'localhost', () => {
      const { port } = s.address()
      s.close((err) => (err ? reject(err) : resolve(port)))
    })
    s.on('error', reject)
  })
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up */
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params)
      }
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result.value
  }
}

async function main() {
  const { takeMs, headed } = parseArgs(process.argv.slice(2))
  const port = await allocatePort()
  const preview = spawn(
    'npx',
    ['vite', 'preview', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'pipe' },
  )
  let previewErr = ''
  preview.stderr?.on('data', (d) => (previewErr += String(d)))

  const profile = mkdtempSync(join(tmpdir(), 'inout-o7-profile-'))
  let chrome
  try {
    await waitForHttp(`http://localhost:${port}/`, Date.now() + 60_000)
    chrome = spawn(
      CHROME,
      [
        ...(headed ? ['--window-size=1200,900'] : ['--headless=new']),
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        `http://localhost:${port}/?synthetic=1`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    // Attach.
    let wsUrl = null
    const deadline = Date.now() + 20_000
    while (!wsUrl && Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
        const page = targets.find((t) => t.type === 'page' && t.url.includes(`:${port}/`))
        if (page) wsUrl = page.webSocketDebuggerUrl
      } catch {
        /* not up */
      }
      if (!wsUrl) await sleep(200)
    }
    if (!wsUrl) throw new Error('no Chrome target')
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('cdp ws failed')), { once: true })
    })
    const cdp = new Cdp(ws)

    const requests = []
    cdp.on('Network.requestWillBeSent', (p) => {
      requests.push({ url: p.request.url, tMs: p.timestamp * 1000, type: p.type })
    })
    const logs = []
    cdp.on('Runtime.consoleAPICalled', (p) => {
      logs.push({
        tMs: p.timestamp,
        text: (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
      })
    })
    await cdp.send('Network.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // Reload so every request is captured from a cold document.
    await cdp.send('Page.reload', { ignoreCache: true })
    await sleep(3000)

    // First-paint payload = what the SERVED DOCUMENT references. Reading the
    // live DOM instead would include vite's __vitePreload links, which the
    // at-mount capture prewarm injects a moment later — those are deliberately
    // after paint and must not be counted as blocking bytes.
    const html = await (await fetch(`http://localhost:${port}/`)).text()
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
    const sizes = {}
    let initialJsBytes = 0
    for (const path of refs) {
      const buf = await (await fetch(`http://localhost:${port}${path}`)).arrayBuffer()
      sizes[path.split('/').pop()] = buf.byteLength
      initialJsBytes += buf.byteLength
    }
    // Everything else the page pulls, split by when and why.
    const afterPaint = await cdp.eval(`(() => {
      const out = {}
      for (const e of performance.getEntriesByType('resource')) {
        if (!/\.js$/.test(e.name)) continue
        out[e.name.split('/').pop()] = Math.round(e.responseEnd)
      }
      return out
    })()`)

    // Record.
    const clickT = Date.now()
    const marker = logs.length
    await cdp.eval(
      `document.querySelector('button[aria-label="Start recording"]').click()`,
    )
    // Wait for the app's own arming logs to say the recorders started.
    let armedMs = null
    const armDeadline = Date.now() + 15_000
    while (armedMs === null && Date.now() < armDeadline) {
      const recording = await cdp.eval(
        `!!document.querySelector('button[aria-label="Stop recording"]')`,
      )
      if (recording) armedMs = Date.now() - clickT
      else await sleep(20)
    }

    const editorReq = requests.find(
      (r) => /EditorScreen/.test(r.url) && r.tMs * 0 === 0,
    )
    // Requests are timestamped on Chrome's monotonic clock; compare by order
    // against the click instead, using a wall-clock probe in the page.
    const editorLoadedMs = await cdp.eval(
      `new Promise((res) => {
         const t0 = performance.now()
         const seen = performance.getEntriesByType('resource').find(e => /EditorScreen/.test(e.name))
         if (seen) return res(Math.round(seen.responseEnd))
         const obs = new PerformanceObserver((list) => {
           for (const e of list.getEntries()) {
             if (/EditorScreen/.test(e.name)) { obs.disconnect(); res(Math.round(e.responseEnd)) }
           }
         })
         obs.observe({ type: 'resource', buffered: true })
         setTimeout(() => { obs.disconnect(); res(null) }, ${takeMs})
       })`,
      true,
    )
    const clickPerfMs = await cdp.eval(`window.__o7ClickAt ?? null`)

    await sleep(Math.max(0, takeMs - (Date.now() - clickT)))
    const editorReadyBeforeStop = logs
      .slice(marker)
      .some((l) => l.text.includes('editor chunk ready'))
    await cdp.eval(
      `document.querySelector('button[aria-label="Stop recording"]')?.click()`,
    )
    await sleep(2500)

    const armingLogs = logs.slice(marker).filter((l) => l.text.includes('[capture:arming]'))
    const report = {
      initialJsBytes,
      initialFiles: sizes,
      afterPaintChunksResponseEndMs: afterPaint,
      armingMs: armedMs,
      armingLogs: armingLogs.map((l) => l.text),
      editorChunkResponseEndMs: editorLoadedMs,
      editorChunkReadyBeforeStop: editorReadyBeforeStop,
      requestsDuringRecordPath: requests
        .filter((r) => r.type === 'Script' || r.type === 'XHR' || r.type === 'Fetch')
        .map((r) => r.url.split('/').pop()),
      takeMs,
      clickPerfMs,
      editorRequestSeen: !!editorReq,
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    if (previewErr) console.error('--- preview stderr ---\n' + previewErr.slice(-1500))
    process.exitCode = 1
  } finally {
    try {
      chrome?.kill('SIGKILL')
    } catch {
      /* dead */
    }
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    preview.kill('SIGTERM')
    await sleep(200)
    try {
      preview.kill('SIGKILL')
    } catch {
      /* dead */
    }
    process.exit(process.exitCode ?? 0)
  }
}

await main()
