#!/usr/bin/env node
/**
 * Screenshot a flow in the PRODUCTION build (vite preview + headless Chrome).
 * Records a short synthetic take, stops, opens Export, and captures the
 * quality panel — visual proof for UI work, on the build users actually get.
 *
 * Usage: node scripts/ui-shot.mjs [--takeMs=4000] [--out=/tmp/shot.png]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT_DEBUG = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let takeMs = 4000
let out = '/tmp/inout-quality.png'
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
  else if (a.startsWith('--out=')) out = a.slice(6)
}

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
const profile = mkdtempSync(join(tmpdir(), 'inout-shot-'))
let chrome
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break
    } catch {}
    await sleep(150)
  }
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT_DEBUG}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--mute-audio',
      '--window-size=1200,900',
      `http://localhost:${port}/?synthetic=1`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let ws = null
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT_DEBUG}/json/list`)).json()
      const page = t.find((x) => x.type === 'page' && x.url.includes(`:${port}/`))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {}
    if (!ws) await sleep(150)
  }
  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (ev) => {
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
      sock.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      .value

  await send('Runtime.enable')
  await sleep(2500)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(takeMs)
  await evaluate(`document.querySelector('button[aria-label="Stop recording"]')?.click()`)
  await sleep(2500)
  const opened = await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(700)
  const text = await evaluate(`document.querySelector('.quality')?.innerText ?? 'NO QUALITY PANEL'`)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(JSON.stringify({ exportButtonFound: opened, panelText: text, screenshot: out }, null, 2))
} finally {
  try { chrome?.kill('SIGKILL') } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  preview.kill('SIGTERM')
  await sleep(200)
  try { preview.kill('SIGKILL') } catch {}
  process.exit(0)
}
