#!/usr/bin/env node
/**
 * WHAT A DRAG ON THE TIMELINE DOES TO THE SOUND — the gate for Robert's
 * 2026-09-02 report, "especially annoying noises when i drag now line in
 * timeline around".
 *
 * The noise is not a mystery: B2 established the mechanism and built the cure.
 * A drag delivers pointermove at up to 120 Hz; while PLAYING, each one moves
 * the playhead further than the audio resync threshold, so every single event
 * hard-seeks each audio element and calls `play()` again — a fresh burst of
 * sound per pointer event. `scrubStart`/`scrubEnd` fix it by holding every
 * element paused for the life of the gesture, and until 2026-09-02 only the
 * transport Scrubber called them. The timeline's own three seek drags — the
 * ruler, a lane, the "now" line — did not.
 *
 * So this counts, WHILE PLAYING AND WHILE DRAGGING, the call that IS the noise:
 * `HTMLMediaElement.play()` on an audio element. A drag that is a scrub makes
 * ZERO of them and holds every element paused from pointerdown to pointerup; a
 * drag that is not makes one per pointer event. It drags each of the three
 * surfaces in turn, because the bug was that they were wired one at a time.
 *
 * SEEKS ARE NOT THE BUG and are counted only as context. B2's cure is "pause
 * everything, THEN seek": moving a paused element is silent, and it is how the
 * picture follows the hand. Their number is reported because it also shows the
 * per-frame throttle working — ~one write per element per 16 ms of gesture, not
 * one per pointer event.
 *
 * HEADED AND VISIBLE, not negotiable: an agent's browser pane is a hidden
 * document where setInterval and rAF are clamped to ~1 Hz, so the master clock
 * barely ticks, playback never really starts, and every count comes back zero
 * whether or not the bug is present. A green run in a hidden pane means
 * nothing at all.
 *
 *   node scripts/drag-noise.mjs [--url=https://inout-kappa.vercel.app] [--take=12]
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
const TAKE_SEC = Number(arg('take', '12'))
const QUERY = arg('query', 'synthetic=1')

/** Drag one surface for real, while playing, counting what it costs the sound. */
const DRAG = (selector, moves) => `
(async () => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return { error: 'no ' + ${JSON.stringify(selector)} }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const audios = [...document.querySelectorAll('audio')]
  if (audios.length === 0) return { error: 'this take has no audio channels' }
  let plays = 0, seeks = 0
  const origPlay = HTMLMediaElement.prototype.play
  const ct = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')
  const count = (fn) => function () { if (this.tagName === 'AUDIO') fn(); return undefined }
  HTMLMediaElement.prototype.play = function () {
    if (this.tagName === 'AUDIO') plays++
    return origPlay.apply(this, arguments)
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    get: ct.get, configurable: true,
    set: function (v) { if (this.tagName === 'AUDIO') seeks++; return ct.set.call(this, v) },
  })

  const restore = () => {
    HTMLMediaElement.prototype.play = origPlay
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', ct)
  }
  try {
    // PLAY FOR REAL, and prove it: a count taken while nothing is playing is
    // the same zero the bug would give.
    document.querySelector('.transport__play')?.click()
    // Sampled rather than slept through, because "it did not play" has several
    // causes and a single late look cannot tell them apart.
    const trace = []
    let reallyPlaying = false
    for (let i = 0; i < 30; i++) {
      await sleep(100)
      trace.push({
        at: i * 100,
        audio: audios.map(a => a.paused ? 'paused/' + a.readyState : 'play@' + a.currentTime.toFixed(2)),
        video: [...document.querySelectorAll('video')].map(v => v.paused ? 'paused/' + v.readyState : 'play@' + v.currentTime.toFixed(2)),
        clock: document.querySelector('.transport__time')?.textContent?.trim(),
      })
      if (audios.some(a => !a.paused && a.currentTime > 0)) { reallyPlaying = true; break }
    }
    plays = 0; seeks = 0

    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, clientX: x, clientY: y, bubbles: true, isPrimary: true, buttons: 1,
    }))
    const pausedEachMove = []
    fire('pointerdown', r.left + 12)
    for (let i = 0; i < ${moves}; i++) {
      // Pointer cadence, ~120 Hz, which is what a trackpad actually delivers.
      await sleep(8)
      fire('pointermove', r.left + 12 + ((r.width - 24) * i) / ${moves})
      pausedEachMove.push(audios.every(a => a.paused))
    }
    const during = { plays, seeks }
    fire('pointerup', r.right - 12)
    await sleep(400)
    const resumed = audios.some(a => !a.paused)
    document.querySelector('.transport__play')?.click()
    await sleep(200)
    return {
      reallyPlaying,
      startTrace: trace.slice(-4),
      startTraceLen: trace.length,
      moves: ${moves},
      playCallsDuringDrag: during.plays,
      audioSeeksDuringDrag: during.seeks,
      audioPausedThroughout: pausedEachMove.every(Boolean),
      resumedAfterPointerUp: resumed,
    }
  } finally {
    restore()
  }
})()
`

async function main() {
  const bin = resolveChrome()
  const profile = mkdtempSync(join(tmpdir(), 'inout-dragnoise-'))
  const url = `${BASE}/?${QUERY}`
  console.error(`drag-noise: ${url}`)
  const chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
  const out = { url, takeSec: TAKE_SEC, surfaces: {}, verdict: '' }
  try {
    await sleep(3000)
    out.visibility = await chrome.evaluate('document.visibilityState')
    if (out.visibility !== 'visible') {
      throw new Error(`the page is ${out.visibility}; every count read here would be the timer clamp`)
    }
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
    await sleep(2000)

    // The three surfaces that move the playhead. They were wired one at a
    // time, so they are checked one at a time.
    for (const [name, selector] of [
      ['ruler', '.tl__ruler'],
      ['lane', '.lane__track'],
      ['playhead', '.tl__playhead'],
    ]) {
      out.surfaces[name] = await chrome.evaluate(DRAG(selector, 24), 120_000)
      await sleep(500)
    }

    const rows = Object.entries(out.surfaces)
    const bad = rows.filter(
      ([, r]) => !r.error && (r.playCallsDuringDrag > 0 || !r.audioPausedThroughout),
    )
    const unplayed = rows.filter(([, r]) => !r.error && !r.reallyPlaying)
    const seeks = rows.map(([n, r]) => `${n} ${r.audioSeeksDuringDrag}`).join(', ')
    out.verdict = unplayed.length
      ? `INCONCLUSIVE: ${unplayed.map(([n]) => n).join(', ')} never actually played, so a zero there proves nothing`
      : bad.length === 0
        ? `PASS: all ${rows.length} surfaces made 0 play() calls and held every audio element paused for the whole drag ` +
          `(silent seeks, which are the point: ${seeks} over ${rows[0][1].moves} moves each)`
        : `FAIL: ${bad
            .map(
              ([n, r]) =>
                `${n} made ${r.playCallsDuringDrag} play() calls` +
                (r.audioPausedThroughout ? '' : ' and let an element play mid-drag'),
            )
            .join('; ')}`
    console.log(JSON.stringify(out, null, 2))
    console.error(`drag-noise: ${out.verdict}`)
    if (out.verdict.startsWith('FAIL') || out.verdict.startsWith('INCONCLUSIVE')) process.exitCode = 1
  } finally {
    await quitChrome(chrome).catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(`drag-noise: ${err.message}`)
  process.exit(1)
})
