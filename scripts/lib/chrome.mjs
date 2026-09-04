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
/**
 * `viaOpen: true` LAUNCHES THROUGH `/usr/bin/open -na` INSTEAD OF spawn(), AND
 * IT IS THE ONLY WAY TO CAPTURE A REAL SCREEN ON THIS MAC (measured 2026-09-04,
 * O4 step 1).
 *
 * macOS attributes a TCC permission to the RESPONSIBLE process, not to the
 * binary that asks. A Chrome spawned from node inherits node's responsibility,
 * node has no Screen Recording grant, and `getDisplayMedia` fails instantly
 * with `NotAllowedError: Permission denied by system` — the same probe, same
 * flags, same profile, launched with `open -na` (launchd is responsible, so the
 * grant is Chrome's own) answers `OK 4096x4096@30`. That is why every screen
 * rig here settled for tab capture; the wall was the launcher, not the picker.
 *
 * The costs, so nobody is surprised: `open` returns as soon as it has asked
 * launchd, so there is no child handle — no stderr, and the kill goes through
 * `pkill -f <profile>` (which is exact: the profile path is a throwaway mkdtemp
 * name that appears in every process of that tree and in no other). Use it only
 * for a lane that needs a real display; spawn stays the default.
 */
/**
 * `throttled: true` LEAVES CHROME'S BACKGROUND THROTTLING ON — the three
 * `--disable-*` flags below are dropped. Every rig here wants them off (a
 * throttled compositor would measure a take nobody records), with exactly one
 * exception: G7 has to measure what a HIDDEN tab does to a clock, because that
 * is what a take actually runs in, and a rig that disables the throttle cannot
 * see it. Use it only for that question.
 */
export async function launchChrome({
  bin,
  profile,
  url,
  headed = true,
  scriptsOff = false,
  extraArgs = [],
  throttled = false,
  viaOpen = false,
}) {
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
    ...(throttled
      ? []
      : [
          '--disable-background-timer-throttling',
          // A window macOS thinks is covered gets its rendering throttled, and a
          // throttled compositor would measure a take nobody records.
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
        ]),
    '--mute-audio',
    '--window-size=900,700',
    '--window-position=0,0',
    ...extraArgs,
  ]
  if (!headed) args.unshift('--headless=new')
  args.push(scriptsOff ? 'about:blank' : url)
  const stderr = []
  let proc = null
  let kill = null
  if (viaOpen) {
    if (process.platform !== 'darwin') throw new Error('chrome: viaOpen is macOS only')
    // .../Google Chrome.app/Contents/MacOS/Google Chrome -> .../Google Chrome.app
    const app = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '')
    execFileSync('/usr/bin/open', ['-na', app, '--args', ...args])
    stderr.push('launched via `open -na` — no child handle, so no stderr from this Chrome')
    kill = () => {
      try {
        execFileSync('/usr/bin/pkill', ['-f', profile], { stdio: 'ignore' })
      } catch {
        /* nothing matched: already gone */
      }
    }
  } else {
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    proc.stderr.on('data', (d) => {
      if (stderr.length < 200) stderr.push(String(d).trim())
    })
    kill = () => {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  }

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
  /**
   * A DEAD TARGET ANSWERS NOTHING, AND THAT USED TO BE A HANG (G8, 2026-09-04).
   *
   * `evaluate` was bounded and every OTHER call was not, so a rig that lost its
   * renderer waited on the first bare `send` forever. memory-slope at max spent
   * 11 and 20 minutes there, printing nothing after its header, and the row that
   * came out of it said the RIG stalls — the tab had crashed 18 s into the take
   * (`Inspector.targetCrashed`, browser-target status "crashed", errorCode 5)
   * and nothing in the rig could say so. So: every call is bounded, and the
   * crash itself is recorded ONCE and fails every later call instantly rather
   * than making each one wait out its own timeout.
   */
  let dead = null
  const killPending = (err) => {
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Inspector.targetCrashed') {
      dead = { crashed: true, atMs: Date.now(), why: "the page's renderer crashed (Inspector.targetCrashed)" }
      killPending(new Error(dead.why))
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      // Capped, and the cap is a ring rather than a cut-off: an hour-long soak
      // outlives any fixed head, and its LAST lines are the interesting ones.
      consoleLines.push(`${m.params.type}: ${text}`)
      if (consoleLines.length > 600) consoleLines.splice(0, 200)
    }
  })
  sock.addEventListener('close', () => {
    dead ??= { crashed: false, atMs: Date.now(), why: 'the CDP connection closed' }
    killPending(new Error(dead.why))
  })
  const send = (method, params = {}, timeoutMs = 30_000) => {
    if (dead) return Promise.reject(new Error(`${method}: ${dead.why}`))
    let timer = null
    return new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      sock.send(JSON.stringify({ id, method, params }))
    }).finally(() => clearTimeout(timer))
  }
  /** Every page-side call is bounded: a media promise that never settles must
   *  fail the run loudly rather than stall it silently. */
  const evaluate = async (expression, timeoutMs = 30_000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
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

  return {
    proc,
    kill,
    port,
    send,
    evaluate,
    evalJson,
    consoleLines,
    stderr,
    url,
    /** `null` while the page is alive; `{ crashed, atMs, why }` once it is not.
     *  A rig reads this to report a dead tab as a dead tab. */
    get dead() {
      return dead
    },
  }
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
  session.kill()
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
  session.kill()
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
