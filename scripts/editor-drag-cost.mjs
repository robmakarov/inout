#!/usr/bin/env node
/**
 * F16b GATE: WHAT DOES THE BACKGROUND RENDER COST THE PERSON DRAGGING?
 *
 * T2 answered this for an IDLE editor (p95 UI lateness 1.1 ms -> 1.0 ms while
 * the pre-render works). F16b's gate says that is not the question: "T2's
 * lateness bands hold with the editor open beside a working job, measured on
 * DRAGS, not idle." An idle main thread has nothing to be late for.
 *
 * WHY THIS IS A SCRIPT AND NOT AN `exp` CELL. The measurement is scheduling
 * lateness on the main thread of the REAL editor, and both halves of that are
 * unavailable to the usual rigs:
 *   · the experimental harness page has no editor in it, and a simulated drag
 *     would be measuring a simulation;
 *   · an agent's browser pane is a HIDDEN document, where setInterval is
 *     clamped to ~1 Hz — every lateness number read through it is the clamp,
 *     not the machine (measured again 2026-09-02: document.hidden === true).
 * So this drives a REAL, VISIBLE, FOCUSED Chrome over CDP — scripts/lib
 * chrome.mjs, the same driver H2/H3 use — records a take through the product,
 * and then drags the playhead across the timeline at pointer cadence, twice:
 * once while the at-stop pre-render works, once after it has finished. The
 * answer is the DELTA between two drags on one machine, which is the only form
 * of this answer that means anything.
 *
 *   node scripts/editor-drag-cost.mjs [--url=http://localhost:5174] [--take=25]
 *
 * Needs a dev server already serving the build under test (the mirror on 5174,
 * or the deployed URL). Leaves nothing running.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const BASE = arg('url', 'http://localhost:5174')
const TAKE_SEC = Number(arg('take', '25'))
const DRAG_SEC = Number(arg('drag', '8'))
const QUERY = arg('query', 'synthetic=1&qstep=max&screensize=3024x1964&prerender=1')

/** The ticker AND the drag, in the page, for a fixed window. */
const MEASURE = (ms) => `
(async () => {
  const el = document.querySelector('.tl__ruler')
  if (!el) return { error: 'no timeline ruler — is the editor open?' }
  const r = el.getBoundingClientRect()
  const y = r.top + r.height / 2
  const x0 = r.left + 8
  const x1 = r.right - 8
  const period = 16
  const late = []
  const spikes = []
  const t00 = performance.now()
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const l = Math.max(0, now - last - period)
    late.push(l)
    // WHERE a stall lands is the whole diagnosis: a hitch at the moment the
    // job finishes is the main thread copying its file, and a hitch in the
    // middle of the drag is contention.
    if (l > 30) spikes.push({ atMs: Math.round(now - t00), lateMs: Math.round(l) })
    last = now
  }, period)
  // A DRAG, as the timeline's own handler sees one: pointerdown on the ruler,
  // then a stream of pointermove at pointer cadence, then pointerup.
  const pd = (type, x) =>
    el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true }))
  pd('pointerdown', x0)
  const t0 = performance.now()
  let moves = 0
  while (performance.now() - t0 < ${ms}) {
    const phase = ((performance.now() - t0) % 4000) / 4000
    pd('pointermove', x0 + (x1 - x0) * (phase < 0.5 ? phase * 2 : 2 - phase * 2))
    moves++
    await new Promise((res) => setTimeout(res, 16))
  }
  pd('pointerup', x1)
  clearInterval(timer)
  late.sort((a, b) => a - b)
  const at = (q) => (late.length ? Math.round(late[Math.min(late.length - 1, Math.floor(q * late.length))] * 10) / 10 : null)
  return {
    ticks: late.length,
    moves,
    hz: Math.round((late.length / (${ms} / 1000)) * 10) / 10,
    p50LateMs: at(0.5),
    p95LateMs: at(0.95),
    maxLateMs: late.length ? Math.round(late[late.length - 1] * 10) / 10 : null,
    totalLateMs: Math.round(late.reduce((a, b) => a + b, 0)),
    spikes,
    playhead: document.querySelector('.transport__time')?.textContent ?? null,
  }
})()
`

async function main() {
  const bin = resolveChrome()
  const profile = mkdtempSync(join(tmpdir(), 'inout-drag-'))
  const url = `${BASE}/?${QUERY}`
  console.error(`drag-cost: ${url}`)
  const chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
  const out = { url, takeSec: TAKE_SEC, dragSec: DRAG_SEC, lanes: {}, verdict: '' }
  try {
    await sleep(3000)
    const visible = await chrome.evaluate('document.visibilityState')
    out.visibility = visible
    if (visible !== 'visible') {
      // The whole reason this script exists. Say it and stop, rather than
      // publishing a clamped number.
      throw new Error(`the page is ${visible}; a lateness number read here would be the clamp`)
    }
    // ---- record one take through the product --------------------------------
    const started = await chrome.evaluate(
      `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
    )
    if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
    await sleep(TAKE_SEC * 1000)
    await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
    // The editor opens on the hand-off; the at-stop pre-render starts with it.
    for (let i = 0; i < 60; i++) {
      const ready = await chrome.evaluate(`!!document.querySelector('.tl__ruler')`)
      if (ready) break
      await sleep(500)
    }
    const jobStarted = chrome.consoleLines.some((l) => l.includes('pre-render started AT STOP'))
    out.atStopJobStarted = jobStarted

    /**
     * WAIT OUT THE SIZE PROBE FIRST, or this measures the wrong thing. The
     * export panel encodes 300 real frames to price its steps when the editor
     * opens (`[quality] size probe`), which takes seconds — and it lands
     * inside the first drag lane and nowhere near the second, so a comparison
     * taken without this wait charges the background render for the panel's
     * own work. Every stall this script found before the wait (35-201 ms,
     * 0.4-0.7 s into the drag) was inside that window.
     */
    for (let i = 0; i < 120; i++) {
      if (chrome.consoleLines.some((l) => l.includes('size probe'))) break
      await sleep(500)
    }
    out.sizeProbeDone = chrome.consoleLines.some((l) => l.includes('size probe'))
    await sleep(1000)

    // ---- lane 1: drag WHILE the background render works ----------------------
    const linesBefore = chrome.consoleLines.length
    out.lanes.withJob = await chrome.evaluate(MEASURE(DRAG_SEC * 1000), 120_000)
    out.lanes.withJob.jobFinishedBefore = chrome.consoleLines
      .slice(0, linesBefore)
      .some((l) => l.includes('pre-render ready'))
    // What the app said DURING the drag — a "pre-render ready" in here means
    // the job landed inside the measured window, and its file copy is a
    // main-thread cost that belongs to finishing, not to running.
    out.lanes.withJob.saidDuring = chrome.consoleLines
      .slice(linesBefore)
      .filter((l) => l.includes('compose') || l.includes('export'))

    // ---- wait for the job to finish, then the same drag with nothing running -
    for (let i = 0; i < 240; i++) {
      const done = chrome.consoleLines.some(
        (l) => l.includes('pre-render ready') || l.includes('pre-render did not finish'),
      )
      if (done) break
      await sleep(1000)
    }
    out.jobFinished = chrome.consoleLines.some((l) => l.includes('pre-render ready'))
    await sleep(2000)
    out.lanes.noJob = await chrome.evaluate(MEASURE(DRAG_SEC * 1000), 120_000)

    const a = out.lanes.withJob
    const b = out.lanes.noJob
    out.verdict =
      `drag p95 lateness ${b.p95LateMs} ms with nothing running -> ${a.p95LateMs} ms beside the background render ` +
      `(delta ${Math.round((a.p95LateMs - b.p95LateMs) * 10) / 10} ms); worst tick ${b.maxLateMs} -> ${a.maxLateMs} ms; ` +
      `ticker ${b.hz} Hz -> ${a.hz} Hz over ${b.ticks}/${a.ticks} ticks, ${b.moves}/${a.moves} pointermoves`
    console.log(JSON.stringify(out, null, 2))
    console.error(`drag-cost: ${out.verdict}`)
  } finally {
    await quitChrome(chrome).catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`drag-cost: ${err.message}`)
  process.exit(1)
})
