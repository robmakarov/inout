#!/usr/bin/env node
/**
 * E3 GATE / PROOF: WHAT DOES A CLAIMED BACKGROUND RENDER STILL OBEY?
 *
 * F16b gave the background render a brake (`core/backgroundWork.ts`) and F16
 * gave it a claim (`takePrerender`): pressing Export while the job is running
 * JOINS it instead of starting the same work again. The two were never
 * introduced to each other. `renderExport` is handed its pace source once, at
 * start, and nothing revokes it — so a render a PERSON IS WAITING FOR keeps
 * obeying a brake written for work nobody asked for.
 *
 * The brake that bites is the editor one, and the geometry is the whole bug:
 * the Export button lives inside the element carrying
 * `onPointerDownCapture={noteEditingActivity}`, so the press that claims the
 * job is itself the event that throttles it to `trickle` — 20 % duty, a 5x
 * slowdown — and every pointer move over the editor while the person watches
 * the dock renews it.
 *
 * THE MEASUREMENT is press -> file, twice, on one machine, one build:
 *   hand   press Export, then move the pointer over the editor at pointer
 *          cadence while the dock counts (what a person watching does).
 *   still  press Export and touch nothing.
 * Same take, same edit, same moment of the press. The delta is the defect.
 *
 *   node scripts/e3-claimpace.mjs [--url=https://inout-kappa.vercel.app] [--take=40]
 *   node scripts/e3-claimpace.mjs --lane=hand      # one lane only
 *
 * Real headed Chrome over CDP: the agent's browser pane is a hidden document
 * and every wall-clock number read through it is the 1 Hz clamp, not the
 * machine. Leaves nothing running.
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
const BASE = arg('url', 'https://inout-kappa.vercel.app')
const TAKE_SEC = Number(arg('take', '40'))
/** How long after the edit settles to wait before pressing. Short enough that
 *  the job is still working (the press must JOIN, not collect). */
const PRESS_AFTER_MS = Number(arg('press', '2500'))
const ONLY = arg('lane', '')
/**
 * G8 (2026-09-04): a SYNTHETIC source at 3024x1964@60 kills the tab 14-28 s
 * into a take. 1080p is where this rig survives, and the defect is about duty
 * cycles, which do not care about the frame size.
 */
const QUERY = arg('query', 'synthetic=1&qstep=1080p&screensize=1920x1080&prerender=1&bgrender=1')

/** Press Export, then wait for the dock to show a saved file. Optionally keep
 *  a hand on the editor the whole time, which is what a person does. */
const PRESS_AND_WAIT = (hand, timeoutMs) => `
(async () => {
  const root = document.querySelector('.editor')
  const btn = document.querySelector('button.qbar__go')
  if (!btn) return { error: 'no Export button' }
  const t0 = performance.now()
  btn.click()
  let moves = 0
  const r = root ? root.getBoundingClientRect() : null
  const timer = ${hand} && r
    ? setInterval(() => {
        // A pointer over the editor, as the capture-phase listener sees one.
        // Not on the timeline: this is somebody watching a progress bar, not
        // dragging anything.
        const x = r.left + 40 + (moves % 20) * 3
        const y = r.top + 40
        root.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true }))
        moves++
      }, 100)
    : null
  try {
    const deadline = performance.now() + ${timeoutMs}
    let sawProgress = false
    while (performance.now() < deadline) {
      if (document.querySelector('.xstrip--progress')) sawProgress = true
      if (document.querySelector('.xstrip--saved')) {
        return { ms: Math.round(performance.now() - t0), moves, sawProgress, timedOut: false }
      }
      if (document.querySelector('.xstrip--failed')) {
        return { error: 'the export failed', ms: Math.round(performance.now() - t0), moves }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    return { ms: Math.round(performance.now() - t0), moves, sawProgress, timedOut: true }
  } finally {
    if (timer) clearInterval(timer)
  }
})()
`

/** One lane, one browser: record, edit, wait, press, wait for the file. */
async function lane(name, hand, out) {
  const bin = resolveChrome()
  const profile = mkdtempSync(join(tmpdir(), 'inout-e3-'))
  const url = `${BASE}/?${QUERY}`
  const chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
  const rec = { lane: name, hand, url }
  try {
    await sleep(3000)
    const visible = await chrome.evaluate('document.visibilityState')
    if (visible !== 'visible') throw new Error(`the page is ${visible}; a wall clock read here is the clamp`)
    // A tab across a deploy tests the old build (CLAUDE.md). This profile is
    // fresh, but the service worker installs on first load, so say what ran.
    rec.build = await chrome.evaluate(
      `(performance.getEntriesByType('resource').map(e => e.name).find(n => /assets\\/index-.*\\.js/.test(n)) || '').split('/').pop()`,
    )

    const started = await chrome.evaluate(
      `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
    )
    if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
    await sleep(TAKE_SEC * 1000)
    await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
    for (let i = 0; i < 60; i++) {
      if (await chrome.evaluate(`!!document.querySelector('.tl__ruler')`)) break
      await sleep(500)
    }
    // The size probe encodes 300 real frames when the editor opens; pressing
    // inside that window would charge the panel's work to this measurement.
    for (let i = 0; i < 120; i++) {
      if (chrome.consoleLines.some((l) => l.includes('size probe'))) break
      await sleep(500)
    }
    rec.sizeProbeDone = chrome.consoleLines.some((l) => l.includes('size probe'))
    await sleep(1000)

    // A frame preset is one click, it is a PIXEL edit (so the export must
    // render rather than copy packets), and it invalidates every chunk — so
    // the job is certainly still running when the press lands.
    const clicked = await chrome.evaluate(
      `(() => {
         const sw = [...document.querySelectorAll('.frame-bar__swatch')];
         if (sw.length < 2) return 'no frame swatches';
         sw[1].click();
         return 'ok';
       })()`,
    )
    if (clicked !== 'ok') throw new Error(`could not make an edit: ${clicked}`)
    await sleep(PRESS_AFTER_MS)
    rec.jobStarted = chrome.consoleLines.some((l) => l.includes('the edit settled'))
    if (!rec.jobStarted) throw new Error('the edit started no background render (bgrender off?)')

    const before = chrome.consoleLines.length
    const r = await chrome.evaluate(PRESS_AND_WAIT(hand ? 'true' : 'false', 240_000), 300_000)
    Object.assign(rec, r)
    rec.said = chrome.consoleLines
      .slice(before)
      .filter((l) => /compose|export/.test(l))
      .slice(0, 24)
    // The one line that proves the brake was still on the claimed job.
    const restedLine = rec.said.find((l) => l.includes('background render rested'))
    rec.restedLine = restedLine ?? null
  } finally {
    await quitChrome(chrome).catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
  out.lanes.push(rec)
  console.error(`e3-claimpace: ${name} — press to file ${rec.ms} ms (${rec.moves} pointer moves)`)
  return rec
}

async function main() {
  const out = { base: BASE, takeSec: TAKE_SEC, pressAfterMs: PRESS_AFTER_MS, lanes: [], verdict: '' }
  if (ONLY !== 'still') await lane('hand', true, out)
  if (ONLY !== 'hand') await lane('still', false, out)
  const hand = out.lanes.find((l) => l.lane === 'hand')
  const still = out.lanes.find((l) => l.lane === 'still')
  if (hand && still && hand.ms && still.ms) {
    out.verdict =
      `a claimed render: press -> file ${still.ms} ms with the hand off the editor, ` +
      `${hand.ms} ms with a pointer moving over it (${(hand.ms / still.ms).toFixed(2)}x, ` +
      `+${hand.ms - still.ms} ms) — same take, same edit, same press moment`
  } else {
    out.verdict = 'one lane only; no delta'
  }
  console.log(JSON.stringify(out, null, 2))
  console.error(`e3-claimpace: ${out.verdict}`)
}

main().catch((err) => {
  console.error(`e3-claimpace: ${err.message}`)
  process.exit(1)
})
