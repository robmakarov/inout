#!/usr/bin/env node
/**
 * X11 — WHAT DOES THE COMPOSITE'S AUDIO MIX COST, AND DOES IT STILL RUN?
 *
 * X11's row promises to kill "the last main-thread capture cost and the ~430 ms
 * PCM port lag" by re-implementing the composite's WebAudio mix as plain DSP
 * inside the compositor worker. That is a heavy change to a TUNED limiter, so
 * its own gates put the before-numbers first. This rig takes them, and it asks
 * the question the row never did:
 *
 *   IS THE PATH X11 WOULD MOVE STILL THE PATH A TAKE RUNS?
 *
 * Because two landed tasks say maybe not, and neither of them updated the row:
 *
 *  · J6 (robert (27), 2026-09-04) made the glued copy PAINT and not ENCODE, by
 *    default. liveCompositeV2 reads `hasAudio = inputs.audio.length > 0 &&
 *    record`, so on `?glue=paint` NOTHING is connected to the tap — no
 *    MediaStreamSource, no gain stage, no limiter — and the worklet only ticks
 *    for the liveness detector. If that is what a shipped take does, the mix
 *    X11 would move does not run on it at all.
 *  · The ~430 ms lag was an ANCHOR defect — a batch wall-clocked when the main
 *    thread received it rather than when its first sample was taken — and it
 *    was fixed by carrying `contextTime`. X11a's gate asked for it to be
 *    re-measured after; no number was ever reported. This measures it.
 *
 * THREE ARMS, and the first one is the whole question:
 *
 *   paint:0    the shipped default. Expect ticks and ZERO batches. If that is
 *              what comes back, X11's premise is gone the way A2's was, and the
 *              honest output of the task is a verdict rather than a rewrite.
 *   record:0   `?glue=record` — yesterday's take, the rung that still carries
 *              the mix. This is the real price of what X11 would move: main
 *              thread ms per second of capture, against G7's 1 ms/s budget.
 *   record:N   the same with a dosed main thread (b12's blocker, verbatim in
 *              shape). THE STAKE: `recvMs` is the stamp compositor.worker.ts
 *              hands WallClockHold, and a stamp taken on a thread that stalls
 *              is the standing suspect behind B13's unexplained `paddedMs` of
 *              0/0/91/366 ms across identical takes. WallClockHold defends with
 *              a persistence window; whether that defence holds under dose has
 *              never been measured. `padded` in the output is that answer.
 *
 *   node scripts/x11-mix.mjs                            # all three, own build
 *   node scripts/x11-mix.mjs --arms=record:0 --take=60
 *   node scripts/x11-mix.mjs --url=https://inout-kappa.vercel.app   # NO: prod
 *                                                       # has no __inoutMixCost
 *
 * HEADED, for b12's reason: headless Chrome has no GPU here and the channels
 * fall back to a MediaRecorder lane, which is a different audio path.
 * ONE CHROME PER CELL, for crash-bound's reason: a page that has recorded once
 * is a different machine.
 * ALWAYS THROUGH THE GATE: scripts/gate.sh node scripts/x11-mix.mjs
 *
 * QA only: the product change it depends on is an instrument (capture/mixCost.ts,
 * `__inoutMixCost()`) and decides nothing.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeProfile, launchChromeRetrying, quitChrome, resolveChrome, sleep, freePort } from './lib/chrome.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const EXTERNAL = arg('url', '')
const ARMS = arg('arms', 'paint:0,record:0,record:1500')
  .split(',')
  .map((s) => {
    const [glue, block] = s.split(':')
    return { glue, blockMs: Number(block ?? '0') }
  })
const TAKE_SEC = Number(arg('take', '30'))
const GAP_MS = Number(arg('gap', '100'))
const SCREEN = arg('screen', '1280x720')
const SCREEN_FPS = Number(arg('screenfps', '30'))
const QSTEP = arg('qstep', 'high')
const CLEAN_HEAD_SEC = Number(arg('head', '6'))
const CLEAN_TAIL_SEC = Number(arg('tail', '4'))
const SETTLE_MS = Number(arg('settle', '8000'))
const OUT = arg('out', join(tmpdir(), `x11-mix-${Date.now()}.json`))

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

function takeUrl(base, glue) {
  const u = new global.URL(base)
  u.searchParams.set('synthetic', '1')
  u.searchParams.set('qstep', QSTEP)
  u.searchParams.set('screensize', SCREEN)
  u.searchParams.set('screenfps', String(SCREEN_FPS))
  u.searchParams.set('glue', glue)
  return u.toString()
}

/** b12's dose, unchanged in shape: busy-wait `block` of every `block + gap` ms
 *  on the main thread and report what was actually burned. */
const BLOCKER = (blockMs, gapMs) => `
(() => {
  const s = { blockedMs: 0, ticks: 0, running: true, startedAt: performance.now() }
  window.__x11 = s
  const loop = () => {
    if (!s.running) return
    setTimeout(() => {
      if (!s.running) return
      const t0 = performance.now()
      while (performance.now() - t0 < ${blockMs}) { /* burn */ }
      s.blockedMs += performance.now() - t0
      s.ticks++
      loop()
    }, ${gapMs})
  }
  loop()
  return 'armed'
})()`

const BLOCKER_STOP = `
(() => {
  const s = window.__x11
  if (!s) return null
  s.running = false
  s.wallMs = performance.now() - s.startedAt
  return JSON.stringify({ blockedMs: Math.round(s.blockedMs), ticks: s.ticks, wallMs: Math.round(s.wallMs) })
})()`

const READ_MIX = `(async () => {
  if (typeof __inoutMixCost !== 'function') return JSON.stringify({ absent: true })
  try { return JSON.stringify(await __inoutMixCost()) } catch (e) { return JSON.stringify({ error: String(e) }) }
})()`

const READ_CARD = `(async () => {
  if (typeof __inoutReport !== 'function') return JSON.stringify(null)
  try {
    const c = await __inoutReport()
    return JSON.stringify(c && {
      verdict: c.verdict,
      line: c.line ?? null,
      channels: (c.dimensions ?? []).find((d) => d.id === 'channels') ?? null,
      lateness: (c.dimensions ?? []).find((d) => d.id === 'lateness') ?? null,
    })
  } catch (e) { return JSON.stringify({ error: String(e) }) }
})()`

/** The raw channels' own padding, for the comparison B13 left open. */
const READ_TAKE = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('inout')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const all = await new Promise((res, rej) => {
    const r = db.transaction('recordings').objectStore('recordings').getAll()
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  return JSON.stringify(rec && {
    id: rec.id,
    durationMs: rec.durationMs,
    composite: rec.composite ? { engine: rec.composite.engine, intake: rec.composite.intake ?? null } : null,
    channels: rec.channels.filter((c) => c.media === 'audio').map((c) => ({
      kind: c.kind,
      durationMs: Math.round(c.durationMs ?? 0),
      paddedMs: c.diagnostics?.paddedMs ?? null,
      trimmedMs: c.diagnostics?.trimmedMs ?? null,
      tapMaxGapMs: c.diagnostics?.tapMaxGapMs ?? null,
    })),
  })
})()`

async function waitFor(s, expr, budgetMs, label) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await s.evaluate(expr, 120_000).catch(() => false)) return true
    await sleep(400)
  }
  throw new Error(`x11: timed out waiting for ${label}`)
}

async function cell(chrome, { glue, blockMs }) {
  await waitFor(chrome, `!!${START_BTN}`, 90_000, 'the record button')
  // crash-bound's settleBeforeRecordMs: a Chrome process's first VideoEncoder
  // pays a multi-second init, and pressing into it measures Chrome warming up.
  await sleep(SETTLE_MS)

  const startWall = await chrome.evaluate(
    `(() => { const b = ${START_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
    120_000,
  )
  if (!startWall) throw new Error('no record button to press')
  await waitFor(chrome, `!!${STOP_BTN}`, 60_000, 'the take to reach recording')

  const dosedSec = Math.max(0, TAKE_SEC - CLEAN_HEAD_SEC - CLEAN_TAIL_SEC)
  await sleep(CLEAN_HEAD_SEC * 1000)
  let dose = null
  if (blockMs > 0) {
    const armed = await chrome.evaluate(BLOCKER(blockMs, GAP_MS), 60_000)
    if (armed !== 'armed') throw new Error(`blocker did not arm: ${armed}`)
  }
  await sleep(dosedSec * 1000)
  if (blockMs > 0) {
    const raw = await chrome.evaluate(BLOCKER_STOP, 120_000)
    dose = raw ? JSON.parse(raw) : null
  }
  await sleep(CLEAN_TAIL_SEC * 1000)

  const stopWall = await chrome.evaluate(
    `(() => { const b = ${STOP_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
    120_000,
  )
  if (!stopWall) throw new Error('the take had already stopped — no stop button')
  await waitFor(chrome, `!!document.querySelector('.tl__ruler')`, 120_000, 'the editor after stop')

  const mix = JSON.parse((await chrome.evaluate(READ_MIX, 120_000)) ?? 'null')
  const card = JSON.parse((await chrome.evaluate(READ_CARD, 120_000)) ?? 'null')
  const take = JSON.parse((await chrome.evaluate(READ_TAKE, 120_000)) ?? 'null')

  return {
    glue,
    blockMs,
    dose,
    dutyMeasured: dose && dose.wallMs ? +(dose.blockedMs / dose.wallMs).toFixed(3) : 0,
    wallMs: stopWall - startWall,
    mix,
    cardVerdict: card?.verdict ?? null,
    cardLateness: card?.lateness?.detail ?? null,
    takeId: take?.id ?? null,
    composite: take?.composite ?? null,
    audioChannels: take?.channels ?? [],
  }
}

function line(c) {
  const m = c.mix ?? {}
  if (m.absent) return `${c.glue}:${c.blockMs} — BUILD HAS NO __inoutMixCost (wrong url?)`
  const raw = (c.audioChannels ?? [])
    .map((a) => `${a.kind} pad${a.paddedMs ?? '?'}ms`)
    .join(' ')
  return (
    `glue=${c.glue.padEnd(6)} block ${String(c.blockMs).padStart(4)}ms duty ${c.dutyMeasured.toFixed(2)} · ` +
    `batches ${String(m.batches ?? 0).padStart(5)} ticks ${String(m.ticks ?? 0).padStart(4)} · ` +
    `main ${(m.handlerMs ?? 0).toFixed(1)}ms = ${(m.handlerMsPerSec ?? 0).toFixed(3)} ms/s · ` +
    `lag p50 ${m.lagP50 ?? '-'} p95 ${m.lagP95 ?? '-'} max ${Math.round(m.lagMax ?? 0)} ms · ` +
    `composite pad ${m.paddedFrames ?? 0} trim ${m.trimmedFrames ?? 0} fr · ` +
    `raw ${raw} · card ${c.cardVerdict}`
  )
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  throw new Error(`server never came up at ${url}`)
}

async function main() {
  const bin = resolveChrome()
  if (!bin) throw new Error('Chrome not found — set CHROME_BIN')

  let vite = null
  let base = EXTERNAL
  if (!base) {
    const port = await freePort()
    // Vite binds `localhost`, which on this machine is ::1 alone (g7's lesson).
    base = `http://localhost:${port}`
    console.error('x11: building the production bundle (npm run build) …')
    await new Promise((res, rej) => {
      const b = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
      b.on('exit', (code) => (code === 0 ? res() : rej(new Error(`build failed (${code})`))))
    })
    vite = spawn('npm', ['run', 'preview', '--', '--port', String(port), '--strictPort'], {
      cwd: ROOT,
      stdio: 'pipe',
    })
    await waitForHttp(`${base}/index.html`, Date.now() + 120_000)
    console.error(`x11: preview (built bundle) on ${base}`)
  }

  const out = { base, takeSec: TAKE_SEC, screen: SCREEN, screenFps: SCREEN_FPS, qstep: QSTEP, cells: [] }
  const profiles = []
  try {
    for (const armSpec of ARMS) {
      const url = takeUrl(base, armSpec.glue)
      const profile = mkdtempSync(join(tmpdir(), `inout-x11-${process.pid}-${armSpec.glue}-${armSpec.blockMs}-`))
      profiles.push(profile)
      let chrome = null
      try {
        chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
        await sleep(3000)
        const visible = await chrome.evaluate('document.visibilityState')
        if (visible !== 'visible') throw new Error(`the page is ${visible} — the dose would be the clamp`)
        const c = await cell(chrome, armSpec)
        c.url = url
        c.console = chrome.consoleLines.filter((l) => /composite|mix|audio|pad|trim/i.test(l)).slice(-30)
        out.cells.push(c)
        console.error(`x11: ${line(c)}`)
      } finally {
        if (chrome) await quitChrome(chrome).catch(() => undefined)
        removeProfile(profile)
      }
    }
  } finally {
    if (vite) vite.kill('SIGTERM')
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.error(`x11: full report ${OUT}`)
  console.log(JSON.stringify(out.cells.map(line), null, 2))
}

main().catch((err) => {
  console.error(`x11: ${err.message}`)
  process.exit(1)
})
