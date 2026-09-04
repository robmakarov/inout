#!/usr/bin/env node
/**
 * X11a PROBE — DOES MOVING THE READER OFF THE MAIN THREAD ACTUALLY MOVE THE READ?
 *
 * THE PREMISE NOBODY HAS CHECKED. X11a's plan is to transfer the track
 * processor's `readable` into a worker so a starved main thread can no longer
 * cost the take audio. But a transferred ReadableStream is a PIPE between two
 * realms, and who turns the crank is not obvious: if the transfer leaves the
 * original stream on the main thread and merely proxies reads over a
 * MessagePort, then a blocked main thread still fails to pump it, the
 * processor's queue still overflows, and the whole task buys nothing. B12
 * measured what the loss costs (~87 ms of platform buffer, 20.1-32.5 s of a
 * 45 s take); this measures whether X11a's lever is connected to anything.
 *
 * HOW IT IS MADE SHARP. B12's fix (a 4 s buffer) hides the effect, so this
 * probe asks for a DELIBERATELY SMALL buffer — the default is 32 quanta, the
 * platform's own depth — and blocks the main thread for far longer than that
 * holds. Then the two arms differ only in WHERE the reader runs:
 *
 *   main    the reader loop runs on the main thread (today's product path)
 *   worker  the readable is transferred and read inside a worker
 *
 * Each arm reports the audio it was handed against the wall time it covered,
 * off `AudioData.timestamp` continuity — B12's `tapGapMs`, standalone. If the
 * worker arm loses what the main arm loses, the transfer is decorative and
 * X11a must transfer the TRACK instead (which P9 measured does not transfer in
 * Chrome at all) or move the whole channel. If it loses nothing, X11a is real.
 *
 * SELF-CONTAINED: builds its own track from an AudioContext oscillator, its own
 * processor and its own worker from a Blob URL. It touches no product code and
 * runs on any page of the app, so what it measures is the PLATFORM, not this
 * build. That is the point — the answer must not depend on our own wiring.
 *
 *   node scripts/x11a-workertap.mjs
 *   node scripts/x11a-workertap.mjs --block=3000 --seconds=20 --buffer=32
 *
 * HEADED, and through the gate: it blocks a main thread for seconds at a time.
 *   scripts/gate.sh node scripts/x11a-workertap.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const PROD_URL = 'https://inout-kappa.vercel.app/'
const args = process.argv.slice(2)
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const URL_BASE = arg('url', PROD_URL)
/** Milliseconds of main thread burned per cycle — far past any small buffer. */
const BLOCK_MS = Number(arg('block', '2000'))
const GAP_MS = Number(arg('gap', '100'))
const SECONDS = Number(arg('seconds', '20'))
/** Quanta the processor may hold. 32 ≈ the platform's own default (~87 ms). */
const BUFFER = Number(arg('buffer', '32'))
const REPS = Number(arg('reps', '2'))
const OUT = arg('out', join(tmpdir(), `x11a-workertap-${Date.now()}.json`))

/**
 * ONE ARM, IN THE PAGE. Builds a fresh track each time so neither arm inherits
 * the other's backlog, runs the dose for the whole window, and reports what the
 * reader was handed. `where` is the only difference between the two arms.
 */
const ARM = (where, blockMs, gapMs, seconds, buffer) => `
(async () => {
  const ctx = new AudioContext()
  await ctx.resume().catch(() => {})
  const osc = new OscillatorNode(ctx, { frequency: 440 })
  const dest = ctx.createMediaStreamDestination()
  osc.connect(dest); osc.start()
  const track = dest.stream.getAudioTracks()[0]
  const rate = track.getSettings().sampleRate || ctx.sampleRate

  if (typeof MediaStreamTrackProcessor === 'undefined') return JSON.stringify({ error: 'no MediaStreamTrackProcessor' })
  const proc = new MediaStreamTrackProcessor({ track, maxBufferSize: ${buffer} })
  const readable = proc.readable

  let stop = null
  const result = new Promise((resolve) => { stop = resolve })
  const t0 = performance.now()

  if ('${where}' === 'worker') {
    // Plain concatenation, no nested template: the worker source is JS text
    // built in Node, and a backtick in here would be one escape too many.
    const src = [
      'let prevEndUs = null, gapUs = 0, maxGapUs = 0, frames = 0, chunks = 0;',
      'const RATE = ' + rate + ';',
      'self.onmessage = async (ev) => {',
      '  if (ev.data.cmd === "read") {',
      '    const reader = ev.data.readable.getReader();',
      '    for (;;) {',
      '      let r;',
      '      try { r = await reader.read() } catch (e) { break }',
      '      if (r.done) break;',
      '      const d = r.value;',
      '      const n = d.numberOfFrames;',
      '      if (prevEndUs !== null) {',
      '        const g = d.timestamp - prevEndUs;',
      '        if (g > 1000) { gapUs += g; if (g > maxGapUs) maxGapUs = g }',
      '      }',
      '      prevEndUs = d.timestamp + Math.round((n / RATE) * 1e6);',
      '      frames += n; chunks++;',
      '      d.close();',
      '    }',
      '  } else if (ev.data.cmd === "report") {',
      '    self.postMessage({ gapMs: gapUs / 1000, maxGapMs: maxGapUs / 1000, frames: frames, chunks: chunks });',
      '  }',
      '};',
    ].join(String.fromCharCode(10))
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    w.onmessage = (ev) => stop(ev.data)
    // THE TRANSFER UNDER TEST.
    try {
      w.postMessage({ cmd: 'read', readable: readable }, [readable])
    } catch (err) {
      return JSON.stringify({ error: 'readable did not transfer: ' + String(err) })
    }
    setTimeout(() => w.postMessage({ cmd: 'report' }), ${seconds} * 1000)
  } else {
    const reader = readable.getReader()
    let prevEndUs = null, gapUs = 0, maxGapUs = 0, frames = 0, chunks = 0
    ;(async () => {
      for (;;) {
        let r
        try { r = await reader.read() } catch { break }
        if (r.done) break
        const d = r.value
        const n = d.numberOfFrames
        if (prevEndUs !== null) {
          const g = d.timestamp - prevEndUs
          if (g > 1000) { gapUs += g; if (g > maxGapUs) maxGapUs = g }
        }
        prevEndUs = d.timestamp + Math.round((n / rate) * 1e6)
        frames += n; chunks++
        d.close()
      }
    })()
    setTimeout(() => stop({ gapMs: gapUs / 1000, maxGapMs: maxGapUs / 1000, frames, chunks }), ${seconds} * 1000)
  }

  // THE DOSE, on the main thread, for the whole window — and counted, so the
  // arm reports the load it actually applied rather than the one it asked for.
  let blockedMs = 0, ticks = 0, dosing = true
  const loop = () => {
    if (!dosing) return
    setTimeout(() => {
      if (!dosing) return
      const s = performance.now()
      while (performance.now() - s < ${blockMs}) { /* burn */ }
      blockedMs += performance.now() - s; ticks++
      loop()
    }, ${gapMs})
  }
  loop()

  const out = await result
  dosing = false
  const wallMs = performance.now() - t0
  try { osc.stop(); track.stop(); await ctx.close() } catch {}
  return JSON.stringify({
    where: '${where}', rate, buffer: ${buffer},
    wallMs: Math.round(wallMs), blockedMs: Math.round(blockedMs), ticks,
    deliveredMs: Math.round((out.frames / rate) * 1000),
    gapMs: Math.round(out.gapMs), maxGapMs: Math.round(out.maxGapMs), chunks: out.chunks,
  })
})()`

async function main() {
  const bin = resolveChrome()
  if (!bin) throw new Error('Chrome not found — set CHROME_BIN')
  const profile = mkdtempSync(join(tmpdir(), `inout-x11a-${process.pid}-`))
  const out = { url: URL_BASE, blockMs: BLOCK_MS, gapMs: GAP_MS, seconds: SECONDS, buffer: BUFFER, arms: [] }
  let chrome = null
  try {
    chrome = await launchChromeRetrying({ bin, profile, url: URL_BASE, headed: true })
    await sleep(4000)
    const visible = await chrome.evaluate('document.visibilityState')
    if (visible !== 'visible') throw new Error(`the page is ${visible} — the dose would be the clamp`)
    for (let r = 0; r < REPS; r++) {
      for (const where of ['main', 'worker']) {
        const raw = await chrome.evaluate(ARM(where, BLOCK_MS, GAP_MS, SECONDS, BUFFER), (SECONDS + 60) * 1000)
        const cell = JSON.parse(raw)
        cell.rep = r + 1
        out.arms.push(cell)
        console.error(
          `x11a: ${cell.error ? `${where} ERROR ${cell.error}` : `${where.padEnd(6)} rep${r + 1} · blocked ${(cell.blockedMs / 1000).toFixed(1)}s of ${(cell.wallMs / 1000).toFixed(1)}s · delivered ${(cell.deliveredMs / 1000).toFixed(1)}s · GAP ${(cell.gapMs / 1000).toFixed(2)}s (max ${cell.maxGapMs}ms) · ${cell.chunks} chunks`}`,
        )
      }
    }
  } finally {
    if (chrome) await quitChrome(chrome).catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.error(`x11a: full report ${OUT}`)
}

main().catch((err) => {
  console.error(`x11a: ${err.message}`)
  process.exit(1)
})
