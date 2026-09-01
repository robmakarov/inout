/**
 * ONE CHROME DRIVER FOR THE MEASUREMENT RIGS (H2/H3, 2026-09-01).
 *
 * `camera-check.mjs` proved the shape — real Chrome, real CDP, the deployed
 * build, answers read out of the files rather than the interface — and by the
 * third rig it was being retyped. This is that shape, once: launch on a
 * throwaway (or deliberately persistent) profile, talk CDP over the ephemeral
 * debug port, and leave nothing running.
 *
 * Zero dependencies: Node >= 22 (native WebSocket + fetch) and installed Chrome.
 *
 * WHY THE PORT IS EPHEMERAL. A fixed one cost cdp-run.mjs three runs in a day:
 * an orphaned Chrome keeps the port, the new Chrome silently binds elsewhere,
 * and the driver polls the orphan's stale target list until it times out.
 *
 * WHY THE CHILD IS DETACHED. Chrome is a process TREE. `detached: true` gives
 * it its own group, so `process.kill(-pid, 'SIGKILL')` reaches the renderer and
 * the GPU process too — killing the parent alone leaves the tab alive, which is
 * the difference between simulating a crash and staging one.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['google-chrome', 'google-chrome-stable'],
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe'],
}

function which(cmd) {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

export function resolveChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const c of CHROME_PATHS[process.platform] ?? []) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c
    } else {
      const found = which(c)
      if (found) return found
    }
  }
  return null
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => (err || !port ? reject(err ?? new Error('no port')) : resolve(port)))
    })
    s.on('error', reject)
  })
}

/**
 * HEADED IS THE DEFAULT AND IT IS A MEASUREMENT DECISION, not a convenience:
 * headless Chrome has no GPU here, so the raw channel's WebCodecs path times
 * out and falls back to MediaRecorder VP9 — a different file, a different
 * codec, and an answer to a question nobody asked (camera-check.mjs, P9).
 */
export async function launchChrome({ bin, profile, url, headed = true, scriptsOff = false, extraArgs = [] }) {
  const port = await freePort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-features=InfiniteSessionRestore',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    // A window macOS thinks is covered gets its rendering throttled, and a
    // throttled compositor would measure a take nobody records.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--window-size=900,700',
    '--window-position=0,0',
    ...extraArgs,
  ]
  if (!headed) args.unshift('--headless=new')
  args.push(scriptsOff ? 'about:blank' : url)
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  const stderr = []
  proc.stderr.on('data', (d) => {
    if (stderr.length < 200) stderr.push(String(d).trim())
  })

  let ws = null
  for (let i = 0; i < 250 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((x) => x.type === 'page')
      if (page) ws = page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    if (!ws) await sleep(200)
  }
  if (!ws) throw new Error('Chrome never exposed a debuggable page')

  const sock = new WebSocket(ws)
  await new Promise((res, rej) => {
    sock.addEventListener('open', res, { once: true })
    sock.addEventListener('error', () => rej(new Error('cdp connect failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  const consoleLines = []
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      // Capped, and the cap is a ring rather than a cut-off: an hour-long soak
      // outlives any fixed head, and its LAST lines are the interesting ones.
      consoleLines.push(`${m.params.type}: ${text}`)
      if (consoleLines.length > 600) consoleLines.splice(0, 200)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  /** Every page-side call is bounded: a media promise that never settles must
   *  fail the run loudly rather than stall it silently. */
  const evaluate = async (expression, timeoutMs = 30_000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`page evaluate timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ])
    return r.result?.value
  }
  /** CDP hands back a string OR an already-decoded value depending on the
   *  shape; accept both rather than stringifying an object into "[object
   *  Object]" and then failing to parse it. */
  const evalJson = async (expression, fallback = null) => {
    const v = await evaluate(expression)
    if (v === undefined || v === null) return fallback
    if (typeof v === 'object') return v
    try {
      return JSON.parse(v)
    } catch {
      return fallback
    }
  }

  await send('Runtime.enable')
  await send('Page.enable')

  return { proc, port, send, evaluate, evalJson, consoleLines, stderr, url }
}

/** Launch, with one retry: a Chrome that never exposes a debug target is a
 *  launch flake, not a finding, and it costs a whole cell. */
export async function launchChromeRetrying(opts) {
  try {
    return await launchChrome(opts)
  } catch (err) {
    console.error(`chrome: launch failed (${err}) — one retry`)
    await sleep(3000)
    return await launchChrome(opts)
  }
}

/** SIGKILL the whole group and wait until nothing of it answers. */
export async function sigkillChrome(session) {
  const killWall = Date.now()
  try {
    process.kill(-session.proc.pid, 'SIGKILL')
  } catch {
    try {
      session.proc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  const killWallAfter = Date.now()
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(300) })
    } catch {
      break
    }
    await sleep(100)
  }
  return { killWall, killWallAfter }
}

export async function quitChrome(session) {
  if (!session) return
  try {
    process.kill(-session.proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  await sleep(500)
}

/**
 * EVERY BYTE THE BROWSER HOLDS, not only the ones the JS heap admits to.
 *
 * This is the number the 8 GB machine actually runs out of: decoded frames,
 * encoder buffers and GPU-backed VideoFrames live outside the JS heap, and
 * `performance.memory` cannot see any of them (R2's GPU-process kill was
 * invisible to it). Read per process off the OS, grouped by Chrome's own
 * --type= switch, so a leak can be attributed to the renderer, the GPU process
 * or a utility rather than to "Chrome".
 */
export function chromeRss(profile) {
  const out = { totalKb: 0, byType: {}, processes: 0 }
  try {
    const raw = execFileSync('/bin/ps', ['-axo', 'pid=,rss=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of raw.split('\n')) {
      if (!line.includes(profile)) continue
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const rssKb = Number(m[2])
      const args = m[3]
      const type = /--type=([a-zA-Z-]+)/.exec(args)?.[1] ?? 'browser'
      out.totalKb += rssKb
      out.byType[type] = (out.byType[type] ?? 0) + rssKb
      out.processes++
    }
  } catch {
    /* ps unavailable — the run says so by reporting zero processes */
  }
  return out
}
