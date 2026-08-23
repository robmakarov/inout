#!/usr/bin/env node
/**
 * P2 gates, on the PRODUCTION build (vite preview + headless Chrome):
 *   1. the manifest and icons are served and parse;
 *   2. the service worker registers and activates;
 *   3. an OFFLINE reload still reaches the capture screen;
 *   4. the worker does not interfere with capture — a synthetic take still
 *      records and stops with the worker controlling the page.
 *
 * (3) and (4) are the ones that matter: a PWA that boots offline but breaks
 * recording is worse than no PWA.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const port = await new Promise((res, rej) => {
  const s = createServer()
  s.listen(0, 'localhost', () => {
    const { port } = s.address()
    s.close((e) => (e ? rej(e) : res(port)))
  })
})
const preview = spawn(join(ROOT, 'node_modules/.bin/vite'), ['preview', '--port', String(port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'pipe',
})
const profile = mkdtempSync(join(tmpdir(), 'inout-pwa-'))
let chrome
const report = {}
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break
    } catch {}
    await sleep(150)
  }
  // 1. manifest + icons served
  const manRes = await fetch(`http://localhost:${port}/manifest.webmanifest`)
  const manifest = await manRes.json()
  const icons = []
  for (const icon of manifest.icons) {
    const r = await fetch(`http://localhost:${port}${icon.src}`)
    icons.push({ src: icon.src, status: r.status, bytes: (await r.arrayBuffer()).byteLength })
  }
  report.manifest = {
    status: manRes.status,
    name: manifest.name,
    display: manifest.display,
    startUrl: manifest.start_url,
    hasMaskable: manifest.icons.some((i) => i.purpose === 'maskable'),
    icons,
  }

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--mute-audio',
      `http://localhost:${port}/?synthetic=1`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let wsUrl = null
  for (let i = 0; i < 120 && !wsUrl; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json()
      const p = t.find((x) => x.type === 'page' && x.url.includes(`:${port}/`))
      if (p) wsUrl = p.webSocketDebuggerUrl
    } catch {}
    if (!wsUrl) await sleep(150)
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true })
    ws.addEventListener('error', () => j(new Error('cdp failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

  await send('Runtime.enable')
  await send('Network.enable')

  // 2. worker registers + activates + controls the page
  report.serviceWorker = await evaluate(`(async () => {
    const reg = await navigator.serviceWorker.ready.catch(() => null)
    return {
      registered: !!reg,
      scope: reg ? reg.scope : null,
      active: !!(reg && reg.active),
      controller: !!navigator.serviceWorker.controller,
    }
  })()`)
  // The first load registers but does not control; reload so it does.
  await send('Page.enable')
  await send('Page.reload')
  await sleep(2500)
  report.serviceWorker.controllerAfterReload = await evaluate(
    `!!navigator.serviceWorker.controller`,
  )

  // 3. offline reload still reaches the capture screen
  await send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  await send('Page.reload')
  await sleep(3000)
  report.offline = await evaluate(`(async () => {
    // Prove the emulation is real before trusting the result: an un-cached URL
    // must fail. navigator.onLine is unreliable under CDP emulation, so it is
    // reported but not believed.
    let uncachedBlocked = false
    try {
      await fetch('/__definitely-not-cached-' + Math.random(), { cache: 'no-store' })
    } catch {
      uncachedBlocked = true
    }
    return {
      networkReallyOffline: uncachedBlocked,
      recordButton: !!document.querySelector('button[aria-label="Start recording"]'),
      wordmark: document.querySelector('.capture__wordmark')?.textContent ?? null,
      navigatorOnLine: navigator.onLine,
    }
  })()`)
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await send('Page.reload')
  await sleep(3000)

  // 4. capture still works with the worker controlling the page
  const controlled = await evaluate(`!!navigator.serviceWorker.controller`)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(4000)
  const stopped = await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(3000)
  report.captureUnderWorker = {
    controlled,
    startedAndStopped: stopped,
    reachedEditor: await evaluate(`!!document.querySelector('.editor')`),
  }
  console.log(JSON.stringify(report, null, 2))
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exitCode = 1
} finally {
  try { chrome?.kill('SIGKILL') } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  preview.kill('SIGTERM')
  await sleep(200)
  try { preview.kill('SIGKILL') } catch {}
  process.exit(process.exitCode ?? 0)
}
