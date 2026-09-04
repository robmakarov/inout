#!/usr/bin/env node
/**
 * B12 — WHY BOTH AUDIO CHANNELS END TENS OF SECONDS EARLY ON A CLEAN STOP.
 *
 * THE OBSERVATION THIS RIG HAS TO EXPLAIN (H2's heavy cells, docs/CRASH_BOUND.md):
 * a 300 s take at a synthetic 2560x1440@60 — three encoders, 354.8 Mpx/s — had
 * screen delivery fall 44 → 0.2 fps and BOTH measured-audio channels ended tens
 * of seconds short of the take on a stop the user pressed normally. Nothing
 * threw, nothing muted, no channel was reported lost; only the report card's
 * `channels` dimension noticed.
 *
 * WHY THAT CELL IS THE WRONG INSTRUMENT FOR THE MECHANISM, and this is the
 * whole reason this rig exists rather than a rerun of crash-bound: in it the
 * MACHINE is saturated (three hardware encoders, a 2560x1440 canvas the rig
 * itself paints sixty times a second) and the MAIN THREAD is starved at the
 * same time, so any loss can be blamed on either and neither can be priced. It
 * is also 300 s a cell on a machine that cannot hold the load, which is how the
 * finding sat unnamed. So the load here is a DOSE: a page-side blocker that
 * busy-waits `--block` ms out of every `--block + --gap` ms on the main thread
 * and reports how much it actually blocked. Nothing else is loaded. If audio
 * time is lost in proportion to main-thread block time, the mechanism is on the
 * main thread and X11a's transfer is the fix; if it is not, the mechanism is
 * the encoder load and X11a would have been built for nothing.
 *
 * THE DISCRIMINATOR, and it is the one number that separates the two ways audio
 * time can go missing: the tap's own chunk timestamps. `AudioData.timestamp` is
 * media time on the track's clock. If the SOURCE renders fewer quanta than wall
 * time (the worklet tap's starvation, audioTap.ts), the chunks that do arrive
 * are still contiguous — media time simply falls behind the wall, which is what
 * WallClockHold's padding repays. If the CONSUMER cannot keep up,
 * MediaStreamTrackProcessor drops the chunks it could not hand over and the
 * timestamps JUMP. A gap in that sequence is audio the platform captured and
 * this page threw away, and no amount of padding gets it back.
 *
 * `tapGapMs` HAS A FLOOR, AND ONLY A CONTROL FINDS IT — B13's lesson, paid
 * again here. On this synthetic source an UNDOSED take reads 1512 ms of gap
 * over 45 s, identical with the buffer at 4000 ms and at the platform default,
 * every one of it in steps of <= 6 ms, and NOTHING is padded and the card is
 * GREEN: the source's own timestamps step without losing samples, so small gaps
 * are not lost audio here. The signal is the LARGE gaps (hundreds of ms to
 * seconds), which appear only under starvation. Always run the `0` cell and
 * subtract it; a number quoted without it is 1.5 s wrong.
 *
 *   node scripts/b12-audiostarve.mjs                       # control + one dose
 *   node scripts/b12-audiostarve.mjs --doses=0,100,300,600 # dose-response
 *   node scripts/b12-audiostarve.mjs --take=60 --gap=100
 *   node scripts/b12-audiostarve.mjs --url=http://localhost:5173
 *
 * Reads the take out of IndexedDB exactly as crash-bound.mjs does, plus the
 * report card, plus (when the build carries it) the tap-gap diagnostics this
 * task added to ChannelDiagnostics.
 *
 * HEADED, because headless Chrome has no GPU here and the raw channels fall
 * back to a MediaRecorder lane — a different audio path from the one under test.
 * ALWAYS THROUGH THE GATE: scripts/gate.sh node scripts/b12-audiostarve.mjs
 *
 * QA only: changes no product code, and the product cannot tell it from a user.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProfile, launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const PROD_URL = 'https://inout-kappa.vercel.app/'
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const URL_BASE = arg('url', PROD_URL)
const TAKE_SEC = Number(arg('take', '45'))
/** Milliseconds of main thread burned per cycle. 0 = the control cell. */
const DOSES = arg('doses', '0,400')
  .split(',')
  .map(Number)
  .filter((n) => n >= 0)
/** Idle milliseconds between blocks. The duty cycle is block/(block+gap). */
const GAP_MS = Number(arg('gap', '100'))
/** The take's own load. Default is the LIGHT source on purpose: the dose is the
 *  variable, and a heavy source would put the machine back in the state that
 *  made the original finding unattributable. `--screen=2560x1440` re-enters it. */
const SCREEN = arg('screen', '1280x720')
const SCREEN_FPS = Number(arg('screenfps', '30'))
const QSTEP = arg('qstep', 'high')
const OUT = arg('out', join(tmpdir(), `b12-audiostarve-${Date.now()}.json`))
/** Seconds of unstarved take before the blocker starts and after it stops, so
 *  the anchor and the wall-clock hold's origin window are taken on a clean
 *  machine — exactly as a real take's first seconds are. */
const CLEAN_HEAD_SEC = Number(arg('head', '8'))
const CLEAN_TAIL_SEC = Number(arg('tail', '5'))
/** Left alone after the page loads, before the press. */
const SETTLE_MS = Number(arg('settle', '10000'))

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

function takeUrl(url) {
  const u = new global.URL(url)
  u.searchParams.set('synthetic', '1')
  u.searchParams.set('qstep', QSTEP)
  u.searchParams.set('screensize', SCREEN)
  u.searchParams.set('screenfps', String(SCREEN_FPS))
  return u.toString()
}

/**
 * THE DOSE. A self-rescheduling timeout that busy-waits on the main thread and
 * counts what it actually burned — asserted rather than assumed, because a
 * throttled or descheduled page would otherwise report a load it never applied.
 */
const BLOCKER = (blockMs, gapMs) => `
(() => {
  const s = { blockedMs: 0, ticks: 0, running: true, startedAt: performance.now() }
  window.__b12 = s
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
  const s = window.__b12
  if (!s) return null
  s.running = false
  s.wallMs = performance.now() - s.startedAt
  return JSON.stringify({ blockedMs: Math.round(s.blockedMs), ticks: s.ticks, wallMs: Math.round(s.wallMs) })
})()`

/** Everything the product wrote down about the newest take. */
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
    lost: rec.lost ?? [],
    seams: rec.seams ?? [],
    channels: rec.channels.map((c) => ({
      id: c.id, kind: c.kind, media: c.media, mimeType: c.mimeType,
      startOffsetMs: c.startOffsetMs, durationMs: c.durationMs,
      diagnostics: c.diagnostics ?? null,
    })),
  })
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

async function waitFor(s, expr, budgetMs, label) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await s.evaluate(expr, 120_000).catch(() => false)) return true
    await sleep(400)
  }
  throw new Error(`b12: timed out waiting for ${label}`)
}

/** One cell: arm, record for TAKE_SEC with the dose applied in the middle, stop
 *  cleanly, read what the product wrote down. */
async function cell(chrome, blockMs) {
  await waitFor(chrome, `!!${START_BTN}`, 90_000, 'the record button')
  // SETTLE BEFORE THE PRESS, crash-bound.mjs's lesson (settleBeforeRecordMs): a
  // Chrome process's first VideoEncoder pays a multi-second init and the app's
  // own encoder warm is still running at first paint. Pressing immediately
  // measures Chrome warming up rather than the take.
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
    // The eval itself has to get through the blocked thread — give it room.
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

  const take = JSON.parse((await chrome.evaluate(READ_TAKE, 120_000)) ?? 'null')
  const card = JSON.parse((await chrome.evaluate(READ_CARD, 120_000)) ?? 'null')
  const wallMs = stopWall - startWall

  const channels = (take?.channels ?? []).map((c) => {
    const end = (c.startOffsetMs ?? 0) + (c.durationMs ?? 0)
    const d = c.diagnostics ?? {}
    return {
      kind: c.kind,
      media: c.media,
      startOffsetMs: Math.round(c.startOffsetMs ?? 0),
      durationMs: Math.round(c.durationMs ?? 0),
      endMs: Math.round(end),
      shortOfTakeMs: Math.round((take?.durationMs ?? 0) - end),
      shortOfWallMs: Math.round(wallMs - end),
      paddedMs: d.paddedMs ?? null,
      trimmedMs: d.trimmedMs ?? null,
      tapGapMs: d.tapGapMs ?? null,
      tapMaxGapMs: d.tapMaxGapMs ?? null,
      tapChunks: d.tapChunks ?? null,
      tap: d.audioTap ?? null,
      revivals: d.revivals ?? null,
      events: (d.events ?? []).map((e) => `${Math.round(e.atMs)}:${e.type}`),
    }
  })

  const audio = channels.filter((c) => c.media === 'audio')
  const worstAudioShort = audio.length ? Math.max(...audio.map((c) => c.shortOfTakeMs)) : null


  return {
    blockMs,
    gapMs: GAP_MS,
    dutyRequested: blockMs > 0 ? +(blockMs / (blockMs + GAP_MS)).toFixed(3) : 0,
    dose,
    dutyMeasured: dose && dose.wallMs ? +(dose.blockedMs / dose.wallMs).toFixed(3) : 0,
    wallMs,
    takeDurationMs: take?.durationMs ?? null,
    takeId: take?.id ?? null,
    lost: take?.lost ?? [],
    seams: take?.seams ?? [],
    worstAudioShortMs: worstAudioShort,
    cardVerdict: card?.verdict ?? null,
    cardChannels: card?.channels?.detail ?? null,
    cardLateness: card?.lateness?.detail ?? null,
    channels,
  }
}

function line(c) {
  const a = c.channels.filter((x) => x.media === 'audio')
  const parts = a.map(
    (x) =>
      `${x.kind}=${(x.durationMs / 1000).toFixed(1)}s short${(x.shortOfTakeMs / 1000).toFixed(1)}s` +
      ` pad${x.paddedMs ?? '?'}ms` +
      (x.tapGapMs === null ? '' : ` gap${Math.round(x.tapGapMs)}ms/max${Math.round(x.tapMaxGapMs ?? 0)}`),
  )
  return (
    `block ${String(c.blockMs).padStart(4)}ms duty ${c.dutyMeasured.toFixed(2)} · ` +
    `wall ${(c.wallMs / 1000).toFixed(1)}s take ${((c.takeDurationMs ?? 0) / 1000).toFixed(1)}s · ` +
    `${parts.join(' · ')} · card ${c.cardVerdict}`
  )
}

async function main() {
  const bin = resolveChrome()
  if (!bin) throw new Error('Chrome not found — set CHROME_BIN')
  const url = takeUrl(URL_BASE)
  const out = { url, takeSec: TAKE_SEC, gapMs: GAP_MS, screen: SCREEN, screenFps: SCREEN_FPS, cells: [] }
  // ONE CHROME PER CELL, and it is not caution: a page that has already
  // recorded is a different machine — a warmed encoder, an editor mounted, a
  // take in the store, a service worker that has run. crash-bound.mjs launches
  // per cell for the same reason. It also kills the whole class of "the record
  // button never came back" the first cut of this rig lost a cell to.
  const profiles = []
  for (const blockMs of DOSES) {
    const profile = mkdtempSync(join(tmpdir(), `inout-b12-${process.pid}-${blockMs}-`))
    profiles.push(profile)
    let chrome = null
    try {
      chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
      await sleep(3000)
      const visible = await chrome.evaluate('document.visibilityState')
      out.visibility = visible
      if (visible !== 'visible') throw new Error(`the page is ${visible} — the dose would be the clamp`)
      const c = await cell(chrome, blockMs)
      c.console = chrome.consoleLines.filter((l) => /audio|tap|pad|trim|starv|encoder/i.test(l)).slice(-40)
      out.cells.push(c)
      console.error(`b12: ${line(c)}`)
    } finally {
      if (chrome) await quitChrome(chrome).catch(() => undefined)
      removeProfile(profile)
    }
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.error(`b12: full report ${OUT}`)
  console.log(JSON.stringify(out.cells.map(line), null, 2))
}

main().catch((err) => {
  console.error(`b12: ${err.message}`)
  process.exit(1)
})
