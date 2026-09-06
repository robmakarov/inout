#!/usr/bin/env node
/**
 * X11a — DOES MOVING THE PCM READER MOVE THE SOUND?
 *
 * The starvation half of X11a is settled (`scripts/x11a-workertap.mjs`, and the
 * product cells in `.ai/wip/x11a.md`): a reader on its own thread keeps every
 * sample a blocked main thread throws away. This rig answers the OTHER half,
 * which is the one that blocks the merge, because sync is Robert's:
 *
 *   the anchor dates sample 0 from when a batch ARRIVES, and a min-filter
 *   strips jitter but never a CONSTANT — so a reader one postMessage away
 *   places the whole take late by the cost of that message. Measured at
 *   +14 ms (anchor 88.3 -> 102.1 ms) on the first build, which is large beside
 *   the 10.8-17.7 ms X14a already owes on this seam.
 *
 * `AudioTapBatch.workerNowMs` exists to remove it: the worker stamps the flush
 * on its OWN `performance.now()` and the main thread converts with the offset
 * it measures between the two realms (core/realmClock.ts), so the arrival is
 * the moment the batch was COMPLETE rather than the moment the main thread got
 * round to it. This rig is the measurement that says whether that worked, and
 * `handoff` on every worker line is the conversion's own error bar.
 *
 * IT USED TO BE `performance.timeOrigin + performance.now()`, converted with
 * the page's own origin. That is not a shared clock: `performance.now()` stops
 * while a Mac sleeps and `timeOrigin` does not, so a page open across a night
 * of sleep read its tap worker 8 h 27 min into the future and placed the whole
 * audio channel there — Robert's 46-minute take opened as 553 minutes.
 *
 * WHY IT IS ITS OWN SCRIPT AND NOT A FLAG ON b12-audiostarve.mjs: that rig's
 * question is loss under a dose, and its cells are 45 s with a blocker in them.
 * This one wants the OPPOSITE machine — no dose, nothing else running, short
 * takes — and it has three requirements the wip note names that no existing rig
 * meets:
 *
 *   1. A QUIET MACHINE. The re-measure that could not be believed ran at load
 *      average 7.5 and its own main-thread control drifted 88.3 -> 126-136 ms.
 *      Every cell waits for quiet (machine.mjs) and carries the load it was
 *      read under; `--minReps` cells whose load exceeded `--band` are reported
 *      and EXCLUDED from the verdict rather than quietly averaged in.
 *   2. THE ARMS INTERLEAVED, alternating order per rep, so a machine that
 *      drifts over the run cannot be read as an arm difference. B12's
 *      `?audiobuf=0` A/B is the shape.
 *   3. THE SOURCE'S OWN STATE ON EVERY CELL. Cells come up with the audio clock
 *      either fresh or long-running (`ctx=` in the product's own first-sample
 *      line) and the anchor tracks that split by ~110 ms. It cannot be pinned
 *      from the rig (see below), so it is printed on every line and beaten by
 *      pairing both arms inside one browser process.
 *
 *   node scripts/x11a-anchor.mjs --url=http://localhost:4173/ --reps=6
 *   node scripts/x11a-anchor.mjs --reps=3 --take=12        # a fast look
 *
 * Exit 0 when the arms agree inside `--tol` ms on every audio channel; 1 when
 * the worker arm is late by more than that (the merge blocker, still standing);
 * 2 when the run itself cannot be believed (too few quiet cells, arms split
 * across source states, a cell that never recorded).
 *
 * QA only: changes no product code, and the product cannot tell it from a user.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'
import { QUIET_BUSY, startLoadSampler, waitForQuiet } from './lib/machine.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const URL_BASE = arg('url', 'http://localhost:4173/')
const REPS = Number(arg('reps', '6'))
const TAKE_SEC = Number(arg('take', '15'))
/** Left alone after load, before the press — b12's lesson: the first
 *  VideoEncoder of a Chrome process pays a multi-second init. */
const SETTLE_MS = Number(arg('settle', '10000'))
const SCREEN = arg('screen', '1280x720')
const SCREEN_FPS = Number(arg('screenfps', '30'))
const QSTEP = arg('qstep', 'high')
/** The band the two arms have to agree inside. The seam this sits on is
 *  10.8-17.7 ms late already (X14a), so a whole quantum (23 ms) is not a
 *  tolerance — half a batch (1024 frames at 48 kHz = 21.3 ms) is the natural
 *  unit and 5 ms is the round number under it. */
const TOL_MS = Number(arg('tol', '5'))
const BAND = Number(arg('band', String(QUIET_BUSY)))
const MIN_REPS = Number(arg('minReps', '3'))
const OUT = arg('out', join(tmpdir(), `x11a-anchor-${Date.now()}.json`))
const THREADS = arg('arms', 'main,worker').split(',')
/**
 * THE CONTROL IS THE SAME ARM TWICE. `--arms=main,main` runs two main-thread
 * cells per rep and pairs them exactly as a real A/B is paired, so the paired
 * Δ it prints is the rig's own noise floor on this machine — the number any
 * arm difference has to beat before it is a difference at all.
 */
const CONTROL = THREADS[0] === THREADS[1]
const ARMS = CONTROL ? [`${THREADS[0]}#1`, `${THREADS[1]}#2`] : THREADS
/**
 * THE SOURCE'S OWN AUDIO CLOCK IS NOT PINNABLE FROM HERE, and that was worth
 * one attempt to establish. A cell comes up with the renderer's audio clock
 * either fresh (`ctx=0.00x s` in the product's first-sample line) or already
 * running (`ctx=12-14 s`, i.e. since page load), and the anchor tracks the
 * split hard: fresh cells read a median ~36 ms, warm cells ~148 ms. Opening a
 * silent AudioContext of the rig's own right after load — the obvious pin, and
 * `--autoplay-policy=no-user-gesture-required` is already on every rig Chrome —
 * does NOT decide it: with the pin running and 8.3 s old, cells still came up
 * on both sides. So the state is REPORTED per cell (`ctx` on every line) and
 * beaten by pairing instead, and the lever is gone rather than left lying about
 * looking like a control.
 */

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

function cellUrl(arm) {
  const u = new global.URL(URL_BASE)
  u.searchParams.set('synthetic', '1')
  u.searchParams.set('qstep', QSTEP)
  u.searchParams.set('screensize', SCREEN)
  u.searchParams.set('screenfps', String(SCREEN_FPS))
  u.searchParams.set('audiotapthread', arm)
  return u.toString()
}

/**
 * The anchor and everything that could explain it, off the take the product
 * actually wrote. `anchor.rawAnchorMs` is the number under test: this channel's
 * offset from the session epoch BEFORE the take-wide shift, which is the only
 * frame in which "the worker arm is 14 ms later" is a statement at all.
 */
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
    channels: rec.channels.filter((c) => c.media === 'audio').map((c) => ({
      id: c.id, kind: c.kind,
      startOffsetMs: c.startOffsetMs, durationMs: c.durationMs,
      rawAnchorMs: c.diagnostics?.anchor?.rawAnchorMs ?? null,
      reportedInputLatencyMs: c.diagnostics?.anchor?.reportedInputLatencyMs ?? null,
      inputLatencyApplied: c.diagnostics?.inputLatencyApplied ?? null,
      paddedMs: c.diagnostics?.paddedMs ?? null,
      trimmedMs: c.diagnostics?.trimmedMs ?? null,
      tapGapMs: c.diagnostics?.tapGapMs ?? null,
      tapMaxGapMs: c.diagnostics?.tapMaxGapMs ?? null,
      tapHandoffMs: c.diagnostics?.tapHandoffMs ?? null,
      tapHandoffP95Ms: c.diagnostics?.tapHandoffP95Ms ?? null,
      tap: c.diagnostics?.audioTap ?? null,
      revivals: c.diagnostics?.revivals ?? null,
    })),
  })
})()`


/**
 * EMPTY THE STORE BETWEEN CELLS — the reason both arms can share one browser.
 *
 * The app SALVAGES on boot and opens the take it finds, so a second take in one
 * process comes up in the editor with no record button. Clearing the stores and
 * OPFS puts every cell on the same starting line: the FIRST take of an empty
 * app, which is the state every other rig in this repo measures. It runs before
 * cell 1 as well, so position 1 and position 2 differ only in what the browser
 * process itself has already done.
 */
const CLEAR_STORE = `(async () => {
  const out = {}
  try {
    for (const k of Object.keys(localStorage)) localStorage.removeItem(k)
  } catch (e) { out.lsErr = String(e) }
  try {
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter(Boolean)
    out.dbs = dbs
    for (const name of dbs) {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
      })
      const names = [...db.objectStoreNames]
      if (names.length) await new Promise((res, rej) => {
        const tx = db.transaction(names, 'readwrite')
        for (const n of names) tx.objectStore(n).clear()
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error)
      })
      db.close()
    }
  } catch (e) { out.dbErr = String(e) }
  try {
    const root = await navigator.storage.getDirectory()
    const names = []
    for await (const [name] of root.entries()) names.push(name)
    for (const n of names) await root.removeEntry(n, { recursive: true }).catch(() => {})
    out.opfs = names.length
  } catch (e) { out.opfsErr = String(e) }
  return JSON.stringify(out)
})()`


async function waitFor(s, expr, budgetMs, label) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await s.evaluate(expr, 120_000).catch(() => false)) return true
    await sleep(400)
  }
  throw new Error(`x11a-anchor: timed out waiting for ${label}`)
}

/** `ctx=0.0090s` / `reader=worker thread`, out of the product's own lines. */
function readSourceState(lines) {
  const state = { readers: [], ctx: [] }
  for (const l of lines) {
    const r = /reader=(\w+) thread/.exec(l)
    if (r) state.readers.push(r[1])
    const c = /ctx=([0-9.]+)s/.exec(l)
    if (c) state.ctx.push(Number(c[1]))
  }
  return state
}

/**
 * ONE TAKE. The Chrome is the CALLER's — see `main()`: both arms run in one
 * browser process, because the anchor's cell-to-cell spread (23-94 ms measured
 * across fresh Chromes) is an order of magnitude larger than the +14 ms under
 * test, and almost all of it is between PROCESSES rather than between arms.
 * The page is reloaded onto the arm's own URL so each take is still the FIRST
 * take of a fresh page, which is the state every other rig measures.
 */
async function cell(chrome, arm, rep, position, tag = arm) {
  const quiet = await waitForQuiet({ band: BAND, label: `x11a-anchor ${arm}` })
  const load = startLoadSampler()
  const goto = async (url) => {
    // A navigation kills the evaluate that started it; that is not an error.
    await chrome.evaluate(`location.href = ${JSON.stringify(url)}`, 30_000).catch(() => undefined)
    await sleep(2500)
  }
  try {
    await goto(cellUrl(arm))
    const cleared = await chrome.evaluate(CLEAR_STORE, 90_000)
    await goto(cellUrl(arm))
    const visible = await chrome.evaluate('document.visibilityState')
    if (visible !== 'visible') throw new Error(`the page is ${visible}`)
    await waitFor(chrome, `!!${START_BTN}`, 90_000, 'the record button')
    await sleep(SETTLE_MS)
    const before = chrome.consoleLines.length

    const startWall = await chrome.evaluate(
      `(() => { const b = ${START_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
      120_000,
    )
    if (!startWall) throw new Error('no record button to press')
    await waitFor(chrome, `!!${STOP_BTN}`, 60_000, 'the take to reach recording')
    await sleep(TAKE_SEC * 1000)
    const stopWall = await chrome.evaluate(
      `(() => { const b = ${STOP_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
      120_000,
    )
    if (!stopWall) throw new Error('the take had already stopped')
    await waitFor(chrome, `!!document.querySelector('.tl__ruler')`, 120_000, 'the editor after stop')

    const take = JSON.parse((await chrome.evaluate(READ_TAKE, 120_000)) ?? 'null')
    if (!take || take.channels.length === 0) throw new Error('the take carries no audio channel')
    // THIS take's lines only — the console survives a same-process navigation.
    const lines = chrome.consoleLines.slice(before).filter((l) => /audio|tap|anchor|reader=/i.test(l))
    const src = readSourceState(lines)
    // THE PREMISE, CHECKED: a cell that asked for the worker and fell back to
    // the main pump is not a worker cell, and averaging it in would hide the
    // very thing the transfer's try/catch exists to do loudly.
    const readers = [...new Set(src.readers)]
    if (readers.length && !readers.every((r) => r === arm))
      throw new Error(`asked for reader=${arm}, the take used ${readers.join('+')}`)
    return {
      arm: tag,
      thread: arm,
      rep,
      position,
      ok: true,
      quietBefore: Math.round(quiet.busy * 1000) / 1000,
      cleared: JSON.parse(cleared ?? 'null'),
      load: load.stop(),
      wallMs: stopWall - startWall,
      takeId: take.id,
      takeDurationMs: take.durationMs,
      lost: take.lost,
      readers,
      ctxFirst: src.ctx.length ? src.ctx : null,
      channels: take.channels,
      anchorLines: lines.filter((l) => /anchor|reader=/.test(l)).slice(-8),
    }
  } catch (err) {
    return { arm: tag, thread: arm, rep, position, ok: false, error: String(err.message ?? err), load: load.stop() }
  }
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10)

function cellLine(c) {
  if (!c.ok) return `rep${c.rep} ${c.arm.padEnd(6)} FAILED — ${c.error}`
  const chans = c.channels
    .map(
      (ch) =>
        `${ch.kind}=${ch.rawAnchorMs === null ? '?' : r1(ch.rawAnchorMs)}ms` +
        `(off ${r1(ch.startOffsetMs)} pad ${ch.paddedMs ?? '?'} gap ${ch.tapGapMs ?? '?'}` +
        `${ch.tapHandoffMs === null ? '' : ` handoff ${ch.tapHandoffMs}/${ch.tapHandoffP95Ms}`})`,
    )
    .join(' · ')
  return (
    `rep${c.rep}.${c.position} ${c.arm.padEnd(6)} busy ${c.quietBefore.toFixed(2)}/${(c.load.meanBusy ?? 0).toFixed(2)} ` +
    `ctx ${c.ctxFirst ? c.ctxFirst.map((x) => x.toFixed(3)).join(',') : '?'} · ${chans}`
  )
}

async function main() {
  const bin = resolveChrome()
  if (!bin) throw new Error('Chrome not found — set CHROME_BIN')
  const cells = []
  console.error(
    `x11a-anchor: ${REPS} reps × ${ARMS.join('/')} paired in one Chrome · ${TAKE_SEC}s takes · ` +
      `${URL_BASE} · tol ${TOL_MS}ms`,
  )
  for (let rep = 1; rep <= REPS; rep++) {
    // ALTERNATE THE ORDER INSIDE THE PAIR. The second take in a browser process
    // is not the first (warm encoder, a take in the store, a service worker
    // that has run), so the order is swapped every rep and the position is
    // carried on every cell — a difference that is really about position then
    // cancels in the paired mean instead of being read as an arm.
    // A control's two cells are the same thread, so there is nothing to
    // alternate — the labels stay with the slot and the order stays fixed.
    const pairs = ARMS.map((tag, i) => ({ tag, thread: THREADS[i] }))
    const order = CONTROL || rep % 2 === 1 ? pairs : [...pairs].reverse()
    const profile = mkdtempSync(join(tmpdir(), `inout-x11a-${process.pid}-${rep}-`))
    let chrome = null
    try {
      chrome = await launchChromeRetrying({ bin, profile, url: 'about:blank', headed: true })
      await sleep(1500)
      for (const [i, slot] of order.entries()) {
        const c = await cell(chrome, slot.thread, rep, i + 1, slot.tag)
        cells.push(c)
        console.error(`x11a-anchor: ${cellLine(c)}`)
      }
    } finally {
      if (chrome) await quitChrome(chrome).catch(() => undefined)
      rmSync(profile, { recursive: true, force: true })
    }
  }

  // The verdict reads only cells that recorded on a machine inside the band.
  const good = cells.filter((c) => c.ok && c.quietBefore <= BAND)
  const kinds = [...new Set(good.flatMap((c) => c.channels.map((ch) => ch.kind)))]
  const anchorOf = (c, kind) => c.channels.find((ch) => ch.kind === kind)?.rawAnchorMs ?? null

  const summary = []
  for (const kind of kinds) {
    const row = { kind, arms: {} }
    for (const arm of ARMS) {
      const xs = good
        .filter((c) => c.arm === arm)
        .map((c) => anchorOf(c, kind))
        .filter((x) => typeof x === 'number')
      row.arms[arm] = {
        n: xs.length,
        mean: r1(xs.length ? mean(xs) : null),
        median: r1(median(xs)),
        sd: r1(xs.length ? sd(xs) : null),
        values: xs.map(r1),
      }
    }
    /**
     * THE PAIRED DIFFERENCE IS THE VERDICT, and the unpaired means are context.
     * Both arms of a rep ran in one browser process minutes apart, so their
     * difference cancels everything the two arms shared — which is most of the
     * spread: unpaired cells across fresh Chromes read 23-94 ms on the same
     * build and the same arm.
     */
    const pairs = []
    for (let rep = 1; rep <= REPS; rep++) {
      const a = good.find((c) => c.rep === rep && c.arm === ARMS[0])
      const b = good.find((c) => c.rep === rep && c.arm === ARMS[1])
      if (!a || !b) continue
      const av = anchorOf(a, kind)
      const bv = anchorOf(b, kind)
      if (typeof av !== 'number' || typeof bv !== 'number') continue
      pairs.push({ rep, [ARMS[0]]: r1(av), [ARMS[1]]: r1(bv), diffMs: r1(bv - av) })
    }
    row.pairs = pairs
    const diffs = pairs.map((p) => p.diffMs)
    row.pairedMeanMs = r1(diffs.length ? mean(diffs) : null)
    row.pairedMedianMs = r1(median(diffs))
    row.pairedSdMs = r1(diffs.length ? sd(diffs) : null)
    // Standard error of the paired mean: with n this small it is the only
    // honest way to say whether a delta inside the band is a delta at all.
    row.pairedSeMs = r1(diffs.length ? sd(diffs) / Math.sqrt(diffs.length) : null)
    row.deltaMs = row.pairedMeanMs
    summary.push(row)
  }

  const out = {
    url: URL_BASE,
    reps: REPS,
    takeSec: TAKE_SEC,
    tolMs: TOL_MS,
    band: BAND,
    arms: ARMS,
    cells,
    summary,
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2))

  console.error('')
  for (const row of summary) {
    const parts = ARMS.map(
      (arm) =>
        `${arm} ${row.arms[arm].median ?? '?'}ms med (${row.arms[arm].mean ?? '?'}±${row.arms[arm].sd ?? '?'}, n=${row.arms[arm].n})`,
    )
    console.error(`x11a-anchor: ${row.kind} anchor — ${parts.join(' vs ')}`)
    const hand = good
      .filter((c) => c.thread === 'worker')
      .map((c) => c.channels.find((ch) => ch.kind === row.kind)?.tapHandoffMs)
      .filter((x) => typeof x === 'number')
    const handP95 = good
      .filter((c) => c.thread === 'worker')
      .map((c) => c.channels.find((ch) => ch.kind === row.kind)?.tapHandoffP95Ms)
      .filter((x) => typeof x === 'number')
    if (hand.length)
      console.error(
        `x11a-anchor: ${row.kind} HANDOFF (worker stamp -> page receipt) median of medians ` +
          `${median(hand)}ms · worst p95 ${Math.max(...handP95)}ms · per cell ${hand.join(', ')}`,
      )
    row.handoffMediansMs = hand
    row.handoffP95sMs = handP95
    console.error(
      `x11a-anchor: ${row.kind} PAIRED Δ(${ARMS[1]}−${ARMS[0]}) mean ${row.pairedMeanMs ?? '?'}ms ` +
        `median ${row.pairedMedianMs ?? '?'}ms sd ${row.pairedSdMs ?? '?'} se ${row.pairedSeMs ?? '?'} ` +
        `· pairs ${row.pairs.map((p) => p.diffMs).join(', ')}`,
    )
  }
  console.error(`x11a-anchor: full report ${OUT}`)

  const pairsUsable = Math.min(...summary.map((r) => r.pairs.length))
  if (!summary.length || pairsUsable < MIN_REPS) {
    console.error(
      `x11a-anchor: INCONCLUSIVE — only ${summary.length ? pairsUsable : 0} usable pair(s), ${MIN_REPS} wanted. ` +
        'The wip note is explicit that an anchor read off a loaded machine is not evidence.',
    )
    process.exit(2)
  }
  if (CONTROL) {
    console.error(
      `x11a-anchor: CONTROL RUN (${THREADS[0]} against itself) — the Δ above is this machine's own ` +
        'noise floor on this measurement, not an arm difference. No verdict is drawn from it.',
    )
    return
  }
  const late = summary.filter((r) => r.deltaMs !== null && Math.abs(r.deltaMs) > TOL_MS)
  if (late.length) {
    console.error(
      `x11a-anchor: FAIL — ${late.map((r) => `${r.kind} Δ${r.deltaMs}ms`).join(', ')} outside ±${TOL_MS}ms. ` +
        'The reader still moves the sound; the merge stays blocked.',
    )
    process.exit(1)
  }
  console.error(
    `x11a-anchor: PASS — every channel's paired Δ inside ±${TOL_MS}ms. The stamp holds the anchor ` +
      'where the main-thread reader puts it.',
  )
}

main().catch((err) => {
  console.error(`x11a-anchor: ${err.message}`)
  process.exit(2)
})
