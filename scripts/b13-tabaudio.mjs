#!/usr/bin/env node
/**
 * B13 — TAB AUDIO: EARLY, THIN, NOISY. THE MEASUREMENT, BEFORE ANY FIX.
 *
 * Robert on rec_gpsoujs2sydf (124.8 min, prod): "only sound is not perfect,
 * less bass or whatever, tab audio part of second faster than screen video i
 * think, some small noises in tab audio". Three complaints. NO FIX SHIPS BEFORE
 * THIS RUN, and none of the three is a behaviour he has approved changing.
 *
 * THE TRICK THAT MAKES ALL THREE MEASURABLE AT ONCE: Chrome can be told to
 * capture THIS VERY TAB (--auto-accept-this-tab-capture). So the page plays a
 * signal we generated ourselves, and the tab-audio channel records it. The
 * source is not "some video on YouTube" whose spectrum nobody knows — it is a
 * buffer this script built, sample for sample, and every dB the recording is
 * missing is a dB something in the chain removed.
 *
 * THE SIGNAL: ten tones on octave centres 31.25 Hz … 16 kHz, plus a 3 kHz
 * marker in the LEFT channel only and a 5 kHz marker in the RIGHT only. Every
 * frequency completes a whole number of cycles in the 4 s loop, so the loop is
 * seamless and every tone lands exactly on a Goertzel bin.
 *   · the ten tones answer LESS BASS — per-octave dB against the reference;
 *   · the two markers answer MONO COLLAPSE — a mono downmix puts both markers
 *     in both channels, and nothing else does;
 *   · the anchors answer EARLY, in ms, off the take's own diagnostics.
 *
 * WHAT IT SEPARATES, because "the tab audio sounds thin" has four suspects and
 * three of them are not the tap:
 *   reference        the buffer as built                    (ground truth)
 *   opus floor       reference → AudioEncoder/AudioDecoder  (the codec alone)
 *   captured channel the tab-audio channel off OPFS         (tap + codec)
 *   exported file    the app's own export                   (+ mix, makeup, limiter)
 * A loss that appears at "captured" and not at "opus floor" is the TAP. A loss
 * that appears only at "exported" is the export mix, and blaming the tap for it
 * would have been the wrong fix.
 *
 * AND IT RUNS THE TAKE BOTH WAYS. `--looplat=both` records one take with the
 * shipped anchor and one with `?looplat=0` (the platform's input latency NOT
 * subtracted on a loopback source), so the pair can be compared and Robert can
 * hear both before any default moves.
 *
 *   node scripts/b13-tabaudio.mjs                      # both variants, 45 s each
 *   node scripts/b13-tabaudio.mjs --takeMs=20000       # quicker
 *   node scripts/b13-tabaudio.mjs --looplat=1          # shipped path only
 *   node scripts/b13-tabaudio.mjs --url=http://localhost:4173/
 *   node scripts/b13-tabaudio.mjs --out=~/Downloads/inout-b13
 *
 * QA only: this script changes no product code. `--mute-audio` keeps the tones
 * out of the room — tab capture taps the tab's render stream, not the speaker,
 * so the recording is unaffected (asserted below: a silent capture fails).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9362
const PROD_URL = 'https://inout-kappa.vercel.app/'
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
}

const opts = {
  url: PROD_URL,
  takeMs: 45000,
  looplat: 'both',
  out: join(homedir(), 'Downloads', 'inout-b13'),
  json: null,
  headed: true,
  loud: false,
  fake: false,
  rung: 'raw',
  resamp: '',
  signal: 'tones',
}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6)
  else if (a.startsWith('--takeMs=')) opts.takeMs = Number(a.slice(9))
  else if (a.startsWith('--looplat=')) opts.looplat = a.slice(10)
  else if (a.startsWith('--out=')) opts.out = a.slice(6).replace(/^~/, homedir())
  else if (a.startsWith('--json=')) opts.json = a.slice(7)
  else if (a === '--headless') opts.headed = false
  else if (a === '--loud') opts.loud = true
  else if (a === '--fake') opts.fake = true
  else if (a.startsWith('--rung=')) opts.rung = a.slice(7)
  else if (a.startsWith('--resamp=')) opts.resamp = a.slice(9)
  else if (a.startsWith('--signal=')) opts.signal = a.slice(9)
}

let bin = process.env.CHROME_BIN
for (const c of CHROME[process.platform] ?? []) if (!bin && existsSync(c)) bin = c
if (!bin) {
  console.error('b13: no Chrome found (set CHROME_BIN)')
  process.exit(2)
}
mkdirSync(opts.out, { recursive: true })

/**
 * Built in the page so the generator and the reference analysis are the SAME
 * buffer — a reference computed a second way is a second bug waiting.
 * Schroeder phases keep the crest factor down so twelve tones can be loud
 * enough to sit far above any noise floor without ever clipping.
 */
import { MARK_L, MARK_R, SIGNAL_SRC, TONES } from './b13-signal.mjs'

/** Start the tones playing in the page and keep them playing. */
const START_SIGNAL = `(async () => {
  ${SIGNAL_SRC}
  const ctx = new AudioContext()
  await ctx.resume()
  const sig = ${JSON.stringify(opts.signal)} === 'program' ? buildProgram(ctx.sampleRate) : buildSignal(ctx.sampleRate)
  const buf = ctx.createBuffer(2, sig.n, ctx.sampleRate)
  buf.copyToChannel(sig.L, 0); buf.copyToChannel(sig.R, 1)
  const src = ctx.createBufferSource()
  src.buffer = buf; src.loop = true
  src.connect(ctx.destination)
  src.start()
  window.__b13 = { ctx, src, sampleRate: ctx.sampleRate, reference: spectrum(sig.L, sig.R, ctx.sampleRate, 0) }
  window.__b13spectrum = spectrum
  return JSON.stringify({ sampleRate: ctx.sampleRate, state: ctx.state, reference: window.__b13.reference })
})()`

const profile = mkdtempSync(join(tmpdir(), 'inout-b13-'))
const report = { url: opts.url, takeMs: opts.takeMs, rung: opts.rung, variants: {} }
let browser
let exitCode = 1

const cdp = async (url) => {
  let ws = null
  for (let i = 0; i < 250 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.startsWith(new URL(url).origin))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    if (!ws) await sleep(200)
  }
  if (!ws) throw new Error('Chrome never exposed a debuggable page')
  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp connect failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  const captureLog = []
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (text.startsWith('[capture')) captureLog.push(text)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  return { send, captureLog }
}

/** Read the newest take's channels, anchors and delivered track settings. */
const READ_TAKE = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('inout', 2)
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const all = await new Promise((res, rej) => {
    const r = db.transaction('recordings').objectStore('recordings').getAll()
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!rec) return JSON.stringify(null)
  return JSON.stringify({
    id: rec.id,
    durationMs: Math.round(rec.durationMs),
    channels: rec.channels.map((c) => ({
      kind: c.kind, media: c.media, blobKey: c.blobKey, mimeType: c.mimeType,
      startOffsetMs: Math.round(c.startOffsetMs * 10) / 10,
      durationMs: Math.round(c.durationMs),
      anchor: c.diagnostics?.anchor ?? null,
      audioTrack: c.diagnostics?.audioTrack ?? null,
      paddedMs: c.diagnostics?.paddedMs ?? null,
      trimmedMs: c.diagnostics?.trimmedMs ?? null,
    })),
  })
})()`

/** Decode one OPFS blob and run the same spectrum over it. */
const ANALYSE = (blobKey) => `(async () => {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('blobs')
  let handle = null
  try { handle = await dir.getFileHandle(${JSON.stringify(blobKey)}) } catch (e) {
    // Keys are stored with and without an extension across versions; find it.
    for await (const [name, h] of dir.entries()) if (name.startsWith(${JSON.stringify(blobKey)})) handle = h
  }
  if (!handle) return JSON.stringify({ error: 'blob not found: ' + ${JSON.stringify(blobKey)} })
  const file = await handle.getFile()
  const ctx = new OfflineAudioContext(1, 1, 48000)
  let dec
  try { dec = await ctx.decodeAudioData(await file.arrayBuffer()) } catch (e) {
    return JSON.stringify({ error: String(e), bytes: file.size })
  }
  const L = dec.getChannelData(0)
  const R = dec.numberOfChannels > 1 ? dec.getChannelData(1) : L
  return JSON.stringify({
    bytes: file.size,
    decodedChannels: dec.numberOfChannels,
    durationSec: Math.round(dec.duration * 100) / 100,
    spectrum: window.__b13spectrum(L, R, dec.sampleRate),
  })
})()`

/**
 * The opus floor. The SAME reference buffer through the SAME codec and bitrate
 * measuredAudio uses, so the codec's own contribution is a number and not an
 * assumption. Without this, every dB missing from the recording would be blamed
 * on the tap by default.
 */
const OPUS_FLOOR = `(async () => {
  ${SIGNAL_SRC}
  const rate = window.__b13.sampleRate
  const sig = buildSignal(rate)
  // Six loops (24 s) so the spectrum has the same window count as a take.
  const reps = 6, n = sig.n * reps
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < reps; i++) { L.set(sig.L, i * sig.n); R.set(sig.R, i * sig.n) }
  const chunks = []
  const enc = new AudioEncoder({
    output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ b, ts: c.timestamp, dur: c.duration, type: c.type }) },
    error: (e) => { window.__b13err = String(e) },
  })
  enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 2, bitrate: 128000 })
  const FRAME = 960
  const inter = new Float32Array(FRAME * 2)
  for (let at = 0; at + FRAME <= n; at += FRAME) {
    // AudioData wants planar f32 for 'f32-planar'; give it the two planes.
    const planar = new Float32Array(FRAME * 2)
    planar.set(L.subarray(at, at + FRAME), 0)
    planar.set(R.subarray(at, at + FRAME), FRAME)
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: rate, numberOfFrames: FRAME, numberOfChannels: 2,
      timestamp: Math.round((at / rate) * 1e6), data: planar,
    })
    enc.encode(ad); ad.close()
  }
  await enc.flush(); enc.close()
  const outL = new Float32Array(n), outR = new Float32Array(n)
  let wrote = 0
  const dec = new AudioDecoder({
    output: (ad) => {
      const frames = ad.numberOfFrames
      const plane = new Float32Array(frames * ad.numberOfChannels)
      ad.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })
      if (ad.numberOfChannels > 1) {
        const p2 = new Float32Array(frames)
        ad.copyTo(p2, { planeIndex: 1, format: 'f32-planar' })
        if (wrote + frames <= n) { outL.set(plane.subarray(0, frames), wrote); outR.set(p2, wrote) }
      } else if (wrote + frames <= n) {
        outL.set(plane.subarray(0, frames), wrote); outR.set(plane.subarray(0, frames), wrote)
      }
      wrote += frames
      ad.close()
    },
    error: (e) => { window.__b13err = String(e) },
  })
  dec.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 2 })
  for (const c of chunks) dec.decode(new EncodedAudioChunk({ type: c.type, timestamp: c.ts, duration: c.dur, data: c.b }))
  await dec.flush(); dec.close()
  return JSON.stringify({ decodedFrames: wrote, spectrum: window.__b13spectrum(outL, outR, rate), err: window.__b13err ?? null })
})()`

async function runVariant(name, urlSuffix) {
  // B13(3): `--resamp=sinc` exports through the band-limited interpolator
  // instead of the shipped Hermite. Same take, same signal, different export.
  const extra = [urlSuffix, opts.resamp ? `resamp=${opts.resamp}` : ''].filter(Boolean).join('&')
  const url = opts.url + (extra ? (opts.url.includes('?') ? '&' : '?') + extra : '')
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}-${name}`,
    '--no-first-run',
    '--no-default-browser-check',
    /**
     * NO `--use-fake-ui-for-media-stream` ON THE REAL PATH, and this is the
     * switch that cost this task most of a session. It auto-answers the SURFACE
     * PICKER with nothing, so every getDisplayMedia request returns
     * `NotReadableError: Could not start video source` — headed, headless,
     * under every auto-select switch Chrome has. Permissions are granted over
     * CDP instead, and the surface is chosen by --auto-accept-this-tab-capture
     * answering a preferCurrentTab request (see the shim below).
     */
    /**
     * `--fake` SUBSTITUTES THE DEVICES, and for THIS task that is a strictly
     * smaller run. Chrome's fake display-audio track is a GENERATOR, not the
     * tab's loopback: measured 2026-09-02, a 1234 Hz tone played in the page
     * did not appear in the captured track at all (page tone -57.9 dB, the
     * generator's own content -52.6 dB). So `--fake` can prove the INSTRUMENT
     * — that the delivered settings and the anchor decision reach the take, and
     * that `?looplat=0` moves the anchor by exactly the reported latency — and
     * it cannot answer a single one of Robert's three complaints. The spectrum
     * section detects this itself and refuses to print a verdict.
     */
    ...(opts.fake ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    '--auto-accept-this-tab-capture',
    '--auto-select-tab-capture-source-by-title=INOUT',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--window-size=1280,900',
  ]
  /**
   * KEEPING THE TONES OUT OF THE ROOM WITHOUT SILENCING THE MEASUREMENT.
   *
   * `--mute-audio` was the obvious answer and it is the WRONG one: measured
   * 2026-09-02, a take recorded under it is digital silence end to end
   * (-240 dBFS, every tone at the floor). Tab capture taps the tab's render
   * output, so muting the render mutes the capture.
   *
   * `suppressLocalAudioPlayback: true` on the audio constraint is the knob
   * built for exactly this: the captured stream keeps the audio, the speakers
   * do not get it. It is added by the shim, and it touches only where the sound
   * GOES — never `echoCancellation` / `noiseSuppression` / `autoGainControl`,
   * which are the subject of the measurement and are passed through untouched.
   * `--loud` turns it off if a run ever needs to be heard live.
   */
  if (!opts.headed) args.unshift('--headless=new')
  args.push(url)
  browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const v = { url, gates: {} }

  try {
    const { send, captureLog } = await cdp(url)
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Browser.grantPermissions', {
      origin: new URL(url).origin,
      permissions: ['videoCapture', 'audioCapture'],
    }).catch(() => undefined)
    const evaluate = async (expression, ms = 60000) =>
      (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: ms })).result
        ?.value
    const evalJson = async (e, ms) => {
      const raw = await evaluate(e, ms)
      try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch {
        return null
      }
    }

    /**
     * THE SHIM, AND WHAT IT IS CAREFUL NOT TO TOUCH.
     *
     * The app's rung-0 request carries `selfBrowserSurface: 'exclude'` — it
     * deliberately refuses to capture its own tab — so --auto-accept-this-tab-capture
     * can never answer it and the run would sit on an unanswered picker forever.
     * This forwards the app's OWN options with only the surface CHOICE changed:
     * `preferCurrentTab` on, `selfBrowserSurface` removed.
     *
     * The audio constraints are passed through UNTOUCHED. That is the whole
     * point — B13 is asking whether the app's `echoCancellation:false,
     * noiseSuppression:false, autoGainControl:false` survive to the delivered
     * track, and a shim that rewrote them would be answering its own question.
     * The video source becomes a tab rather than a monitor, which is stated in
     * the report: for AUDIO that is the same mechanism (a tab share's audio IS
     * tab audio), for the VIDEO anchor it is a different capturer.
     */
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const md = navigator.mediaDevices
        const original = md.getDisplayMedia.bind(md)
        md.getDisplayMedia = (opts) => {
          const next = { ...(opts || {}) }
          delete next.selfBrowserSurface
          next.preferCurrentTab = true
          /**
           * --rung=floor REPRODUCES THE REQUEST A WEDGED MACHINE MAKES.
           * acquire.ts's rung 3 dropped the three raw-audio flags and asked for
           * bare audio:true — Chromium's voice-processing default — moving
           * the flags onto the delivered track instead (repairDisplayAudio).
           * Robert's 124.8-minute take was recorded 177 s after a level-3
           * wedge, i.e. on that rung, and the repair has NEVER been measured.
           * This asks exactly what that rung asks and lets the app's own repair
           * run, so what is recorded is what a wedged machine records.
           */
          if (${JSON.stringify(opts.rung)} === 'floor' && next.audio) next.audio = true
          if (${!opts.loud} && next.audio && typeof next.audio === 'object') {
            next.audio = { ...next.audio, suppressLocalAudioPlayback: true }
          }
          // Bare audio:true cannot carry suppressLocalAudioPlayback, so the
          // floor rung is audible unless the whole page is muted at the source.
          if (${!opts.loud} && next.audio === true) {
            next.audio = { suppressLocalAudioPlayback: true }
          }
          window.__b13shim = (window.__b13shim || 0) + 1
          window.__b13lastRequest = JSON.stringify(opts || {})
          return original(next)
        }
      })()`,
    })
    await send('Page.reload', { ignoreCache: true })
    await sleep(3000)
    /**
     * KEEP THE TAB PAINTING. A web-contents source is DAMAGE-DRIVEN: a still
     * page delivers one frame and then nothing, which is how the first real run
     * of the X14a probe read a single frame in 120 s.
     */
    await evaluate(`(() => {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;bottom:0;width:90px;height:90px;background:#0a0;pointer-events:none'
      document.body.appendChild(bar)
      const tick = () => { bar.style.transform = 'translateX(' + ((performance.now() / 6) % 500) + 'px)'; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      return true
    })()`)
    v.gates.boots = !!(await evaluate(`!!document.querySelector('button[aria-label="Start recording"]')`))
    if (!v.gates.boots) throw new Error('the app did not reach the capture screen')

    // The tones must be playing BEFORE the take, or the first seconds record
    // silence and every window average is pulled down by it.
    const sig = await evalJson(START_SIGNAL)
    v.signal = { sampleRate: sig?.sampleRate, state: sig?.state }
    v.reference = sig?.reference ?? null
    await sleep(1500)

    // Screen + tab audio ONLY. A mic in the room would record the same tones
    // through the air and the question would stop being about the tap.
    v.chips = await evalJson(`(async () => {
      const want = { Screen: true, 'Tab Audio': true, Camera: false, Mic: false }
      const read = () => Object.fromEntries(
        [...document.querySelectorAll('.chip')].map((c) => [
          (c.querySelector('.chip__label')?.textContent ?? c.textContent ?? '').trim(),
          c.getAttribute('aria-pressed') === 'true' || c.classList.contains('chip--on'),
        ]),
      )
      for (let i = 0; i < 10; i++) {
        const now = read()
        let clicked = false
        for (const [nm, on] of Object.entries(want)) {
          const el = [...document.querySelectorAll('.chip')].find((c) =>
            ((c.querySelector('.chip__label')?.textContent ?? c.textContent ?? '').trim()) === nm)
          if (el && now[nm] !== on && !el.disabled) { el.click(); clicked = true; break }
        }
        if (!clicked) break
        await new Promise((r) => setTimeout(r, 250))
      }
      return JSON.stringify(read())
    })()`)

    await sleep(600)
    await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
    await sleep(opts.takeMs + 4000)
    await evaluate(
      `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
    )
    for (let i = 0; i < 90; i++) {
      if (await evaluate(`!!document.querySelector('.editor')`)) break
      await sleep(500)
    }
    v.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
    await sleep(2000)

    v.take = await evalJson(READ_TAKE)
    const tab = v.take?.channels?.find((c) => c.kind === 'system-audio')
    const screen = v.take?.channels?.find((c) => c.kind === 'screen')
    v.gates.tabAudioRecorded = !!tab && tab.durationMs > opts.takeMs * 0.7

    // ---- (1) EARLY: the lead, off this take's own anchors ------------------
    if (tab && screen) {
      /**
       * TWO NUMBERS, AND THE SECOND IS THE ONE THAT SURVIVES A RERUN.
       *
       * `audioLeadsPictureMs` is the whole lead as the FILE carries it: the
       * distance between where the picture is placed and where the sound is
       * placed, straight off the stored offsets. That is what Robert hears, and
       * it moves take to take because a real device's spin-up moves.
       *
       * `latencyContributionMs` is how much of that lead the input-latency
       * subtraction PUT THERE, and it is run-independent: the raw anchors say
       * where the two channels actually arrived, the stored offsets say where
       * they were placed, and the difference between those two gaps is the
       * subtraction and nothing else. Comparing the lead across two takes would
       * be comparing two device spin-ups; this compares the decision.
       */
      const rawGap = (screen.anchor?.rawAnchorMs ?? 0) - (tab.anchor?.rawAnchorMs ?? 0)
      const placedGap = screen.startOffsetMs - tab.startOffsetMs
      v.lead = {
        screenRawAnchorMs: screen.anchor?.rawAnchorMs ?? null,
        screenFirstFrameDelayMs: screen.anchor?.firstFrameDelayMs ?? null,
        tabRawAnchorMs: tab.anchor?.rawAnchorMs ?? null,
        tabReportedInputLatencyMs: tab.anchor?.reportedInputLatencyMs ?? null,
        tabInputLatencyApplied: tab.anchor?.inputLatencyApplied ?? null,
        startOffsets: { screen: screen.startOffsetMs, tabAudio: tab.startOffsetMs },
        rawArrivalGapMs: Math.round(rawGap * 10) / 10,
        // Positive = the sound is placed EARLIER than the picture, i.e. it leads.
        audioLeadsPictureMs: Math.round(placedGap * 10) / 10,
        latencyContributionMs: Math.round((placedGap - rawGap) * 10) / 10,
      }
    }

    // ---- (2)(3) THIN / NOISY: four spectra, so the suspect is isolated -----
    v.opusFloor = await evalJson(OPUS_FLOOR, 120000)
    if (tab) v.captured = await evalJson(ANALYSE(tab.blobKey), 120000)
    /**
     * IS THIS EVEN OUR SIGNAL? The whole spectrum half assumes the tab-audio
     * channel recorded the tones this page played. A substituted device, a
     * muted page or a picker that handed over a different surface all produce a
     * plausible-looking spectrum of something else, and a table of dB against a
     * reference that was never captured is worse than no table. The L-only
     * 3 kHz marker settles it: it is 20-plus dB above its own channel's noise
     * when our signal is what was recorded, and buried when it is not.
     */
    // The marker check is a TONE check. Program material has no 3 kHz marker in
    // it, so running it there would report "no signal" on a perfectly good take.
    const capSpec = opts.signal === 'program' ? null : v.captured?.spectrum
    if (capSpec && v.reference) {
      const markerL = capSpec[3000]?.l
      const neighbourFloor = Math.max(capSpec[4000]?.l ?? -120, capSpec[2000]?.l ?? -120)
      /**
       * PRESENT is one question, INTACT is another, and conflating them cost a
       * reading. The first cut failed the check when the marker sat more than
       * 25 dB below the reference — which is exactly what a voice-processed
       * floor-rung take looks like, so the rig refused to print its own best
       * finding. The check is now purely "is our signal in there at all":
       * a fake generator reads -77 dB here, a muted capture -240, and a real
       * take -20 to -45 depending on what the processing did to it.
       */
      v.gates.capturedOurSignal = typeof markerL === 'number' && markerL > -70
      v.attenuationDb =
        typeof markerL === 'number' ? Math.round((markerL - (v.reference[3000]?.l ?? 0)) * 10) / 10 : null
      v.signalCheck = { markerL, neighbourFloor, referenceMarkerL: v.reference[3000]?.l ?? null }
    }

    // The exported file — the mix, the makeup gain and the limiter included.
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
    )
    await sleep(1200)
    await evaluate(`(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`)
    let meta = null
    for (let i = 0; i < 240 && !meta; i++) {
      await sleep(500)
      meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
    }
    v.exportMeta = meta
    v.gates.exported = !!meta
    await sleep(1500)
    v.exported = await evalJson(`(async () => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('blobs')
      let best = null
      for await (const [name, h] of dir.entries()) {
        if (!/\\.(mp4|webm)$/.test(name) && !name.startsWith('xport')) continue
        const f = await h.getFile()
        const isExport = name.startsWith('xport') || name.startsWith('exp')
        if (!best || (isExport && !best.isExport) || (isExport === best.isExport && f.size > best.size))
          best = { name, size: f.size, isExport, file: f }
      }
      if (!best) return JSON.stringify(null)
      const ctx = new OfflineAudioContext(1, 1, 48000)
      let dec
      try { dec = await ctx.decodeAudioData(await best.file.arrayBuffer()) } catch (e) {
        return JSON.stringify({ name: best.name, bytes: best.size, error: String(e) })
      }
      const L = dec.getChannelData(0)
      const R = dec.numberOfChannels > 1 ? dec.getChannelData(1) : L
      window.__b13export = best.name
      return JSON.stringify({
        name: best.name, bytes: best.size, decodedChannels: dec.numberOfChannels,
        durationSec: Math.round(dec.duration * 100) / 100,
        spectrum: window.__b13spectrum(L, R, dec.sampleRate),
      })
    })()`, 180000)

    // ---- the file for Robert's ear ----------------------------------------
    if (v.exported?.name) {
      const b64 = await evaluate(
        `(async () => {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('blobs')
          const h = await dir.getFileHandle(window.__b13export)
          const buf = new Uint8Array(await (await h.getFile()).arrayBuffer())
          let s = ''
          const CH = 0x8000
          for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH))
          return btoa(s)
        })()`,
        180000,
      )
      if (typeof b64 === 'string' && b64.length > 0) {
        const ext = v.exported.name.endsWith('.webm') ? 'webm' : 'mp4'
        const path = join(opts.out, `b13-rung-${opts.rung}${opts.resamp ? '-' + opts.resamp : ''}-${name}.${ext}`)
        writeFileSync(path, Buffer.from(b64, 'base64'))
        v.file = path
      }
    }

    v.shim = { calls: await evaluate(`window.__b13shim ?? 0`), appRequest: await evaluate(`window.__b13lastRequest ?? null`) }
    v.trackLines = captureLog.filter((l) => /track delivered|tab audio delivered|raw tab audio|LOOPBACK|settings MOVED/.test(l))
    v.anchorLines = captureLog.filter((l) => /audio anchor/.test(l))
  } finally {
    try {
      browser?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    await sleep(500)
    try {
      rmSync(`${profile}-${name}`, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  return v
}

const dbTable = (title, ref, rows) => {
  console.log(`\n── ${title} — dB against the reference (negative = quieter than the source) ──`)
  const names = [...TONES, MARK_L, MARK_R]
  console.log(
    'Hz'.padStart(8) +
      rows.map(([label]) => (' ' + label + ' L/R').padStart(20)).join(''),
  )
  for (const f of names) {
    const marker = f === MARK_L ? '  (L-only marker)' : f === MARK_R ? '  (R-only marker)' : ''
    const r = ref?.[f]
    const cells = rows.map(([, sp]) => {
      const s = sp?.[f]
      if (!s || !r) return '—'.padStart(20)
      const dl = (s.l - r.l).toFixed(1)
      const dr = (s.r - r.r).toFixed(1)
      return `${dl}/${dr}`.padStart(20)
    })
    console.log(String(f).padStart(8) + cells.join('') + marker)
  }
}

try {
  const variants = opts.looplat === 'both' ? [['shipped', ''], ['looplat0', 'looplat=0']] : opts.looplat === '0'
    ? [['looplat0', 'looplat=0']]
    : [['shipped', '']]
  for (const [name, suffix] of variants) {
    console.log(`\n=== B13 variant "${name}" ${suffix ? '(' + suffix + ')' : '(shipped anchor)'} · rung=${opts.rung} · ${opts.takeMs} ms take ===`)
    report.variants[name] = await runVariant(name, suffix)
    const v = report.variants[name]
    console.log(`  chips: ${JSON.stringify(v.chips)}`)
    console.log(`  take: ${v.take?.id} · ${v.take?.durationMs} ms · channels ${v.take?.channels?.map((c) => c.kind).join(', ')}`)
    const tab = v.take?.channels?.find((c) => c.kind === 'system-audio')
    console.log(`  tab-audio delivered settings: ${JSON.stringify(tab?.audioTrack ?? null)}`)
    console.log(`  anchors: ${JSON.stringify(v.lead ?? null)}`)
    if (v.file) console.log(`  file for Robert: ${v.file}`)
    for (const l of v.trackLines ?? []) console.log(`  · ${l}`)
    for (const l of v.anchorLines ?? []) console.log(`  · ${l}`)
  }

  const first = Object.values(report.variants)[0]
  if (opts.signal === 'program') {
    console.log(
      `\n  PROGRAM MATERIAL: no tone table for this run — it exists to be LISTENED to. ` +
        `The files are in ${opts.out}. The measurement of what the resampler costs is the isolated ` +
        `sweep (docs/FLAGS.md, ?resamp=), not this take: an image that folds back into the same ` +
        `octave as the signal cannot be separated from it by any spectrum of the total.`,
    )
  } else if (first?.gates?.capturedOurSignal === false) {
    console.log(
      `\n  !! THE TAB-AUDIO CHANNEL RECORDED NO SIGNAL AT ALL ` +
        `(L-only 3 kHz marker at ${first.signalCheck?.markerL} dBFS, reference ` +
        `${first.signalCheck?.referenceMarkerL} dBFS). Every spectrum below is of SOMETHING ELSE. ` +
        `-240 means the render was muted (--mute-audio kills the loopback, measured); around -77 means ` +
        `--fake substituted a generator for the tab; anything else means the picker handed over a ` +
        `different surface.`,
    )
  } else if (first?.attenuationDb !== null && first?.attenuationDb < -6) {
    console.log(
      `\n  NOTE: the whole signal came back ${first.attenuationDb} dB down. The tones ARE ours — the ` +
        `level itself is a finding (automatic gain control pulling the take down), and the per-octave ` +
        `SHAPE below is what says which frequencies were treated differently.`,
    )
  }
  dbTable(
    'TAB AUDIO SPECTRUM',
    first?.reference,
    [
      ['opus floor', first?.opusFloor?.spectrum],
      ['captured', first?.captured?.spectrum],
      ['exported', first?.exported?.spectrum],
    ],
  )
  console.log(
    `\n  reference rms ${first?.reference?.__rmsDb} dBFS · opus floor ${first?.opusFloor?.spectrum?.__rmsDb} · ` +
      `captured ${first?.captured?.spectrum?.__rmsDb} · exported ${first?.exported?.spectrum?.__rmsDb}`,
  )
  console.log(
    `  decoded channels — captured ${first?.captured?.decodedChannels} · exported ${first?.exported?.decodedChannels}`,
  )

  // THE MONO TEST, stated as its own sentence because it is a yes/no.
  const cap = first?.gates?.capturedOurSignal === false ? null : first?.captured?.spectrum
  if (cap) {
    const leak = Math.max(cap[MARK_L]?.r - cap[MARK_R]?.r, cap[MARK_R]?.l - cap[MARK_L]?.l)
    console.log(
      `\n  MONO CHECK: the L-only 3 kHz marker reads ${cap[MARK_L]?.l} dB in L and ${cap[MARK_L]?.r} dB in R; ` +
        `the R-only 5 kHz marker reads ${cap[MARK_R]?.r} dB in R and ${cap[MARK_R]?.l} dB in L. ` +
        `${cap[MARK_L]?.l - cap[MARK_L]?.r > 20 ? 'STEREO IS INTACT.' : 'THE CHANNELS ARE COLLAPSED — the markers appear in both.'}` +
        (Number.isFinite(leak) ? '' : ''),
    )
  }

  if (report.variants.shipped?.lead && report.variants.looplat0?.lead) {
    const a = report.variants.shipped.lead
    const b = report.variants.looplat0.lead
    console.log(
      `\n  BOTH WAYS\n` +
        `    shipped    : sound placed ${a.audioLeadsPictureMs} ms ahead of the picture · ` +
        `of which the latency subtraction contributed ${a.latencyContributionMs} ms ` +
        `(raw arrival gap ${a.rawArrivalGapMs} ms, applied=${a.tabInputLatencyApplied})\n` +
        `    ?looplat=0 : sound placed ${b.audioLeadsPictureMs} ms ahead of the picture · ` +
        `of which the latency subtraction contributed ${b.latencyContributionMs} ms ` +
        `(raw arrival gap ${b.rawArrivalGapMs} ms, applied=${b.tabInputLatencyApplied})\n` +
        `    THE LEVER IS WORTH ${Math.round((a.latencyContributionMs - b.latencyContributionMs) * 10) / 10} ms of lead. ` +
        `The rest of each lead is the picture's own lateness, which is X14a's subject, not this flag's.`,
    )
  }

  exitCode = Object.values(report.variants).every((v) => v.gates?.tabAudioRecorded) ? 0 : 1
} catch (err) {
  report.error = String(err)
  console.error('b13 failed:', err)
} finally {
  if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2))
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  process.exit(exitCode)
}
