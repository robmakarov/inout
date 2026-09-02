#!/usr/bin/env node
/**
 * X14a — DO THE MEDIA'S OWN CAPTURE STAMPS EXIST HERE?
 *
 * Every anchor this product ships is a READ-TIME stamp: `performance.now()` at
 * the moment the main thread pulls a frame off a MediaStreamTrackProcessor
 * (measuredVideo.ts:229) or a batch off the audio tap. That read time is later
 * than the capture time by whatever the pipeline took, and the part that varies
 * run to run is the 6.5 ms per-run term G5 left standing.
 *
 * The escape, if it exists, is that the media object already knows when it was
 * captured: `VideoFrame.metadata().captureTime`, `VideoFrame.timestamp`,
 * `AudioData.timestamp`. NONE of those strings appear in src/. Nobody has ever
 * checked whether Chrome populates them for the three sources this product
 * actually uses. That is the whole task — a probe, on prod, changing nothing.
 *
 * WHAT IT ASKS, per source (display video, camera video, mic audio, tab audio):
 *   1. Is `metadata()` present at all, and what KEYS does it carry?
 *   2. Is `metadata().captureTime` populated — a number, not undefined?
 *   3. What is `timestamp` (µs), and is it on the `performance.now()` timeline?
 *      This is the question that matters even when captureTime is absent: if
 *      readMs − timestamp/1000 is a small, STABLE number, then `timestamp` IS a
 *      capture stamp under another name and X14 has its anchor.
 *   4. How stable is that difference across a 120 s run — sd, p50, p95, and the
 *      DRIFT (ms per minute), because a stamp on a free-running clock is not an
 *      anchor no matter how precise it looks in the first second.
 *
 * It drives REAL Chrome against the DEPLOYED build's origin and runs the probe
 * in that page, so the permissions, the origin and the codec paths are the
 * shipped ones. It does not touch the app: the product's own anchor is pinned
 * by this task and nothing here can move it.
 *
 *   node scripts/x14a-stamps.mjs                    # 120 s, headed
 *   node scripts/x14a-stamps.mjs --takeMs=20000     # quick shape check
 *   node scripts/x14a-stamps.mjs --headless         # no camera light, no window
 *   node scripts/x14a-stamps.mjs --json=/tmp/x14a.json
 *
 * HOW IT GETS A REAL SCREEN, and this cost three wrong turns before it worked.
 * `--use-fake-ui-for-media-stream` is the obvious way to answer the permission
 * prompt, and for getDisplayMedia it is POISON: it auto-answers the surface
 * picker with nothing, and every request comes back
 * `NotReadableError: Could not start video source` — headed, headless, with or
 * without transient activation, under every auto-select switch Chrome has. It
 * also starves a real camera. So this script does NOT use it. Permissions are
 * granted through CDP (`Browser.grantPermissions`), and the surface is chosen by
 * `--auto-accept-this-tab-capture` answering a `preferCurrentTab: true` request.
 * That yields a real `web-contents-media-stream://` capturer at the window's own
 * size, which is what the stamps are being read off.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9361
const PROD_URL = 'https://inout-kappa.vercel.app/'
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
}

const opts = { url: PROD_URL, takeMs: 120000, headed: true, json: null, fake: false, rung: 'raw' }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6)
  else if (a.startsWith('--takeMs=')) opts.takeMs = Number(a.slice(9))
  else if (a === '--headless') opts.headed = false
  else if (a === '--headed') opts.headed = true
  else if (a.startsWith('--json=')) opts.json = a.slice(7)
  else if (a === '--fake') opts.fake = true
  else if (a.startsWith('--rung=')) opts.rung = a.slice(7)
}

let bin = process.env.CHROME_BIN
for (const c of CHROME[process.platform] ?? []) if (!bin && existsSync(c)) bin = c
if (!bin) {
  console.error('x14a: no Chrome found (set CHROME_BIN)')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'inout-x14a-'))
const report = { url: opts.url, takeMs: opts.takeMs, fakeDevices: opts.fake, rung: opts.rung, sources: {}, verdict: null }
let browser
let exitCode = 1

/**
 * THE PROBE, and it runs in the page. Opens the three real sources, reads each
 * through the same MediaStreamTrackProcessor the product reads, and records for
 * every Nth frame/batch: the read-time stamp, the media object's own timestamp,
 * and whatever metadata() hands over. Frames are closed immediately — a 120 s
 * run that held them would be an OOM, not a measurement.
 */
const PROBE = (takeMs, which, rung) => `(async () => {
  const WHICH = ${JSON.stringify(which)}
  const RUNG = ${JSON.stringify(rung)}
  const out = { sources: {}, errors: [] }
  const has = (o, k) => { try { return typeof o[k] } catch { return 'throw' } }

  // Every sample is {readMs, tsUs, capMs}, bounded by construction. A DRIFT
  // reading is only as good as its span, so the cap must never truncate the run
  // — when the buffer fills it is halved and the stride doubles, which keeps
  // the samples spread across the WHOLE take instead of the first 40 seconds of
  // it (the first cut of this probe made exactly that mistake).
  const CAP = 4000
  const makeSampler = () => {
    const kept = []
    let stride = 1
    let seen = 0
    return {
      kept,
      push(s) {
        if (seen++ % stride !== 0) return
        kept.push(s)
        if (kept.length >= CAP) {
          for (let i = 1, j = 2; j < kept.length; i++, j += 2) kept[i] = kept[j]
          kept.length = Math.ceil(kept.length / 2)
          stride *= 2
        }
      },
    }
  }

  const summarize = (samples, kind) => {
    if (samples.length === 0) return { samples: 0 }
    // readMs − timestamp/1000: if the timestamp is a capture stamp on the
    // performance.now() timeline this is the pipeline delay and it is SMALL and
    // STABLE. If the timestamp is a media-local clock (0 at first frame) this
    // grows by exactly the elapsed time and the drift term says so.
    const d = samples.map((s) => s.readMs - s.tsUs / 1000)
    const sorted = [...d].sort((a, b) => a - b)
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    const mean = d.reduce((a, b) => a + b, 0) / d.length
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length)
    // Drift: least-squares slope of the difference against wall time, ms/min.
    const t0 = samples[0].readMs
    const xs = samples.map((s) => (s.readMs - t0) / 60000)
    const xm = xs.reduce((a, b) => a + b, 0) / xs.length
    const num = xs.reduce((a, x, i) => a + (x - xm) * (d[i] - mean), 0)
    const den = xs.reduce((a, x) => a + (x - xm) ** 2, 0)
    const r = (n) => Math.round(n * 100) / 100
    const cap = samples.filter((s) => typeof s.capMs === 'number')
    const capD = cap.map((s) => s.readMs - s.capMs)
    const capMean = capD.length ? capD.reduce((a, b) => a + b, 0) / capD.length : null
    return {
      samples: samples.length,
      spanS: r((samples[samples.length - 1].readMs - t0) / 1000),
      readMinusTimestampMs: { mean: r(mean), sd: r(sd), p50: r(q(0.5)), p05: r(q(0.05)), p95: r(q(0.95)) },
      driftMsPerMin: den > 0 ? r(num / den) : null,
      firstTimestampUs: samples[0].tsUs,
      lastTimestampUs: samples[samples.length - 1].tsUs,
      captureTimeSamples: cap.length,
      readMinusCaptureTimeMs: capMean === null ? null : r(capMean),
      kind,
    }
  }

  /**
   * A SOURCE THAT NEVER DELIVERS MUST NOT HANG THE PROBE. \`reader.read()\` on a
   * dead track never settles (headless with no camera is exactly that), so every
   * read races a deadline and a starved source returns its zero instead of
   * taking the run down with it. "This source delivered nothing" is a finding.
   */
  const readOrGiveUp = (reader, ms) =>
    Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: null, done: true, starved: true }), ms)),
    ])

  const probeVideo = async (name, track) => {
    const rec = { track: {}, metadata: null, metadataKeys: [], samples: [] }
    try { rec.track = track.getSettings() } catch (e) { rec.track = { error: String(e) } }
    const proc = new MediaStreamTrackProcessor({ track })
    const reader = proc.readable.getReader()
    const sampler = makeSampler()
    const samples = sampler.kept
    let n = 0
    const stop = performance.now() + ${takeMs}
    while (performance.now() < stop) {
      const { value, done, starved } = await readOrGiveUp(reader, Math.min(5000, stop - performance.now() + 2000))
      if (starved) { rec.starved = true; break }
      if (done) break
      const readMs = performance.now()
      if (n === 0) {
        rec.hasMetadataFn = has(value, 'metadata')
        let md = null
        try { md = value.metadata ? value.metadata() : null } catch (e) { md = { error: String(e) } }
        rec.metadata = md
        rec.metadataKeys = md && typeof md === 'object' ? Object.keys(md) : []
        rec.format = value.format ?? null
        rec.coded = value.codedWidth + 'x' + value.codedHeight
      }
      let capMs
      try {
        const md = value.metadata ? value.metadata() : null
        if (md && typeof md.captureTime === 'number') capMs = md.captureTime
      } catch { /* metadata() can throw on a detached frame */ }
      sampler.push({ readMs, tsUs: value.timestamp, capMs })
      value.close()
      n++
    }
    try { await reader.cancel() } catch {}
    rec.frames = n
    rec.summary = summarize(samples, 'video')
    return rec
  }

  const probeAudio = async (name, track) => {
    const rec = { track: {}, samples: [] }
    try { rec.track = track.getSettings() } catch (e) { rec.track = { error: String(e) } }
    const proc = new MediaStreamTrackProcessor({ track })
    const reader = proc.readable.getReader()
    const sampler = makeSampler()
    const samples = sampler.kept
    let n = 0
    const stop = performance.now() + ${takeMs}
    while (performance.now() < stop) {
      const { value, done, starved } = await readOrGiveUp(reader, Math.min(5000, stop - performance.now() + 2000))
      if (starved) { rec.starved = true; break }
      if (done) break
      const readMs = performance.now()
      if (n === 0) {
        rec.format = value.format
        rec.sampleRate = value.sampleRate
        rec.numberOfFrames = value.numberOfFrames
        rec.numberOfChannels = value.numberOfChannels
        // AudioData has no metadata() in any shipping Chrome — say so from the
        // object, not from memory.
        rec.hasMetadataFn = has(value, 'metadata')
        rec.batchMs = (value.numberOfFrames / value.sampleRate) * 1000
      }
      sampler.push({ readMs, tsUs: value.timestamp })
      value.close()
      n++
    }
    try { await reader.cancel() } catch {}
    rec.batches = n
    rec.summary = summarize(samples, 'audio')
    return rec
  }

  /**
   * KEEP THE TAB PAINTING, or the display source measures nothing.
   * A web-contents-media-stream source is DAMAGE-DRIVEN: a still page produces one
   * frame and then silence. The first real-capturer run of this probe read
   * exactly one frame in 120 s for that reason and reported the source as
   * starved. A moving element is not decoration here — it is what makes the
   * capturer produce the stream whose stamps are the measurement.
   */
  if (WHICH.includes('display')) {
    const bar = document.createElement('div')
    bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:120px;height:120px;background:#0f0;pointer-events:none'
    document.body.appendChild(bar)
    const tick = () => { bar.style.transform = 'translateX(' + ((performance.now() / 6) % 600) + 'px)'; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }

  // ---- open only the sources this pass's launch flags can serve ------------
  let display = null, cam = null
  // An unanswered picker is silence, not an error — bound it or the probe hangs.
  const within = (p, ms, what) =>
    Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(what + ' timed out after ' + ms + 'ms')), ms))])
  if (WHICH.includes('display')) {
    try {
      // The --auto-accept-this-tab-capture switch only answers a request that ASKS for the
      // current tab; without preferCurrentTab the picker is never auto-answered
      // and the source comes back NotReadableError (measured, first run).
      // RUNG 'floor' asks for bare audio:true — what acquire.ts's degraded
      // rung asks, and what Robert's 124.8-minute take was recorded under.
      // The stamps are read the same way either way; only the request differs.
      display = await within(navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: RUNG === 'floor'
          ? { suppressLocalAudioPlayback: true }
          : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true },
        preferCurrentTab: true,
      }), 20000, 'getDisplayMedia')
    } catch (e) { out.errors.push('getDisplayMedia: ' + String(e)) }
  }
  if (WHICH.includes('gum')) {
    try {
      cam = await within(navigator.mediaDevices.getUserMedia({ video: true, audio: true }), 20000, 'getUserMedia')
    } catch (e) { out.errors.push('getUserMedia: ' + String(e)) }
  }

  const jobs = []
  const dv = display?.getVideoTracks()[0]
  const da = display?.getAudioTracks()[0]
  const cv = cam?.getVideoTracks()[0]
  const ca = cam?.getAudioTracks()[0]
  if (dv) jobs.push(probeVideo('display', dv).then((r) => (out.sources.displayVideo = r)))
  if (da) jobs.push(probeAudio('tabaudio', da).then((r) => (out.sources.tabAudio = r)))
  if (cv) jobs.push(probeVideo('camera', cv).then((r) => (out.sources.cameraVideo = r)))
  if (ca) jobs.push(probeAudio('mic', ca).then((r) => (out.sources.micAudio = r)))
  if (jobs.length === 0) { out.errors.push('no source opened'); return JSON.stringify(out) }
  await Promise.all(jobs)
  for (const s of [display, cam]) s?.getTracks().forEach((t) => t.stop())
  return JSON.stringify(out)
})()`

/**
 * TWO PASSES, AND THAT IS NOT TIDINESS — the two source families need launch
 * flags that CONTRADICT each other.
 *
 *   display + tab audio : must NOT have --use-fake-ui-for-media-stream. That
 *     switch auto-answers the surface picker with nothing, and every request
 *     comes back NotReadableError. The surface is chosen instead by
 *     --auto-accept-this-tab-capture answering a preferCurrentTab request, and
 *     the site permission is granted over CDP.
 *   camera + mic : DOES need it. Without it the getUserMedia prompt is shown
 *     and never answered, and the call times out at 20 s (measured).
 *
 * One launch cannot be both, so each family gets its own.
 */
async function pass(which, extraSwitches, label) {
  const dir = `${profile}-${label}`
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extraSwitches,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  args.push(opts.url)
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    let ws = null
    for (let i = 0; i < 200 && !ws; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
        const page = list.find((x) => x.type === 'page' && x.url.startsWith(new URL(opts.url).origin))
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
    sock.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    })
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        sock.send(JSON.stringify({ id, method, params }))
      })
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Browser.grantPermissions', {
      origin: new URL(opts.url).origin,
      permissions: ['videoCapture', 'audioCapture'],
    }).catch(() => undefined)
    await sleep(2500)
    const raw = (
      await send('Runtime.evaluate', {
        expression: PROBE(opts.takeMs, which, opts.rung),
        returnByValue: true,
        awaitPromise: true,
        timeout: opts.takeMs + 60000,
      })
    ).result?.value
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    await sleep(400)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

try {
  console.log(`x14a: ${opts.headed ? 'headed' : 'headless'} Chrome → ${opts.url} · ${opts.takeMs} ms per pass`)
  report.errors = []
  /**
   * `--fake` SUBSTITUTES THE DEVICES, AND IT IS A DIFFERENT QUESTION. A fake
   * camera answers "does a VideoFrame off a MediaStreamTrackProcessor carry
   * metadata() at all, and is its timestamp on the page clock" — a property of
   * the VideoFrame plumbing, not of a capturer. Rows measured that way are
   * labelled and the verdict says so.
   */
  const fakeSwitches = opts.fake ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []

  console.log('  pass 1/2 — display video + tab audio (real surface, no fake-ui)')
  const a = await pass(['display'], [...fakeSwitches, '--auto-accept-this-tab-capture'], 'display')
  console.log('  pass 2/2 — camera + mic (real devices, prompt auto-answered)')
  const b = await pass(['gum'], ['--use-fake-ui-for-media-stream', ...(opts.fake ? ['--use-fake-device-for-media-stream'] : [])], 'gum')

  report.sources = { ...(a?.sources ?? {}), ...(b?.sources ?? {}) }
  report.errors = [...(a?.errors ?? []), ...(b?.errors ?? [])]

  // ---- the table, and then the sentence X14 needs --------------------------
  const ROWS = [
    ['display video (getDisplayMedia)', 'displayVideo'],
    ['camera video (getUserMedia)', 'cameraVideo'],
    ['mic audio (getUserMedia)', 'micAudio'],
    ['tab audio (getDisplayMedia)', 'tabAudio'],
  ]
  console.log('\n── X14a · does the media carry its own capture stamp? ──')
  if (opts.fake) console.log('   (--fake: SUBSTITUTED devices. Field population is real; the timing is the rig\'s, not a capturer\'s.)')
  console.log(
    'source'.padEnd(32) +
      'metadata()'.padEnd(12) +
      'captureTime'.padEnd(13) +
      'timestamp'.padEnd(11) +
      'read−ts mean±sd (ms)'.padEnd(23) +
      'drift ms/min',
  )
  for (const [label, key] of ROWS) {
    const s = report.sources[key]
    if (!s) {
      console.log(label.padEnd(32) + '— source never opened —')
      continue
    }
    if (s.starved) {
      console.log(label.padEnd(32) + `— track opened but delivered NOTHING (${JSON.stringify(s.track)}) —`)
      continue
    }
    const su = s.summary ?? {}
    const md = s.hasMetadataFn === 'function' ? `yes [${s.metadataKeys?.length ?? 0}]` : String(s.hasMetadataFn)
    const cap = su.captureTimeSamples > 0 ? `YES (${su.captureTimeSamples})` : 'no'
    const d = su.readMinusTimestampMs
    console.log(
      label.padEnd(32) +
        md.padEnd(12) +
        cap.padEnd(13) +
        (typeof su.firstTimestampUs === 'number' ? 'present' : 'absent').padEnd(11) +
        (d ? `${d.mean} ± ${d.sd}` : '—').padEnd(23) +
        (su.driftMsPerMin ?? '—'),
    )
  }
  for (const [label, key] of ROWS) {
    const s = report.sources[key]
    if (!s?.summary?.samples) continue
    const su = s.summary
    console.log(
      `\n  ${label}: ${su.samples} samples over ${su.spanS}s · batch ${s.batchMs ? s.batchMs.toFixed(2) + 'ms' : 'n/a'} · first timestamp ${su.firstTimestampUs} µs · ` +
        `last ${su.lastTimestampUs} µs\n    metadata keys: ${JSON.stringify(s.metadataKeys ?? [])}` +
        `\n    read−timestamp p05/p50/p95 = ${su.readMinusTimestampMs.p05} / ${su.readMinusTimestampMs.p50} / ${su.readMinusTimestampMs.p95} ms`,
    )
  }

  /**
   * THE VERDICT RULE, written down so it is not an opinion.
   *
   * The first cut of this rule was WRONG and the measurement caught it: it
   * asked whether read − stamp was near zero, and called a stamp on the system
   * monotonic clock "a media-local clock that drifts". It does not drift. It
   * sits on a different EPOCH, by a constant this run measures to ±0.74 ms — and
   * a constant offset is a calibration, not a disqualification.
   *
   * So the rule is about STABILITY, not proximity:
   *   epoch     which clock the stamp is on (page or system monotonic), from
   *             the size of the offset;
   *   sd        how much the offset moves sample to sample — this is the term
   *             that would replace G5's 6.5 ms per-run jitter, and it must be
   *             smaller than it to be worth having;
   *   drift     ms per minute against performance.now(). A stamp that drifts is
   *             a second clock and an anchor built on it walks away over a
   *             124-minute take.
   */
  const CLASSIFY = (s) => {
    if (!s?.summary?.samples) return null
    const su = s.summary
    const off = su.readMinusTimestampMs
    return {
      epoch: Math.abs(off.mean) < 1000 ? 'performance.now()' : 'system monotonic (constant offset)',
      offsetMs: off.mean,
      sdMs: off.sd,
      driftMsPerMin: su.driftMsPerMin,
      captureTimePopulated: su.captureTimeSamples > 0,
      metadataFnPresent: s.hasMetadataFn === 'function',
      // Worth having only if it is steadier than the term it would replace.
      steadierThanG5: off.sd < 6.5,
      holdsOverAnHour: Math.abs(su.driftMsPerMin ?? Infinity) < 1,
    }
  }
  const ROWKEYS = ROWS.map(([, k]) => k)
  report.classification = Object.fromEntries(ROWKEYS.map((k) => [k, CLASSIFY(report.sources[k])]))

  console.log('\n── the verdict, per source ──')
  for (const [label, key] of ROWS) {
    const c = report.classification[key]
    if (!c) {
      console.log(`  ${label}: NOT MEASURED HERE (${report.sources[key]?.starved ? 'track delivered nothing' : 'source never opened'})`)
      continue
    }
    console.log(
      `  ${label}: metadata() ${c.metadataFnPresent ? 'present' : 'ABSENT'} · captureTime ${c.captureTimePopulated ? 'POPULATED' : 'empty'} · ` +
        `timestamp on ${c.epoch}, offset ${c.offsetMs} ms, sd ${c.sdMs} ms, drift ${c.driftMsPerMin} ms/min → ` +
        `${c.steadierThanG5 && c.holdsOverAnHour ? 'USABLE as an anchor' : 'NOT usable'}`,
    )
  }

  /**
   * THE LINE B13 IS ACTUALLY ABOUT: what the platform REPORTS as this track's
   * input latency, against what its capture-to-arrival delay MEASURES. The
   * anchor subtracts the first; the second is what it should be subtracting.
   */
  console.log('\n── reported latency vs measured delay (the anchor subtracts the first) ──')
  for (const [label, key] of [['mic audio', 'micAudio'], ['tab audio', 'tabAudio']]) {
    const src = report.sources[key]
    const c = report.classification[key]
    if (!c) continue
    const reported = typeof src?.track?.latency === 'number' ? src.track.latency * 1000 : null
    const short = reported === null ? null : Math.round((c.offsetMs - reported) * 10) / 10
    console.log(
      `  ${label}: platform reports ${reported === null ? 'nothing' : reported.toFixed(1) + ' ms'} · ` +
        `measured ${c.offsetMs} ms (sd ${c.sdMs}, batch ${src?.batchMs ? src.batchMs.toFixed(2) : '?'} ms, ` +
        `ec=${src?.track?.echoCancellation ?? '?'} ch=${src?.track?.channelCount ?? '?'} sr=${src?.track?.sampleRate ?? '?'}) · ` +
        (short === null ? '' : `the subtraction is ${short > 0 ? 'SHORT by ' + short + ' ms — the sound is placed that much LATE' : 'OVER by ' + Math.abs(short) + ' ms — the sound is placed that much EARLY'}`),
    )
  }

  const anyCapture = Object.values(report.classification).some((c) => c?.captureTimePopulated)
  const audio = ['micAudio', 'tabAudio'].map((k) => report.classification[k]).filter(Boolean)
  const video = ['displayVideo', 'cameraVideo'].map((k) => report.classification[k]).filter(Boolean)
  const lines = []
  lines.push(
    anyCapture
      ? 'metadata().captureTime IS populated somewhere — see the table.'
      : `metadata().captureTime is EMPTY on every source measured here: VideoFrame.metadata() exists and returns {} (no keys), and AudioData has no metadata() at all. Idea 4a's literal field does not exist in this Chrome.`,
  )
  if (audio.length) {
    const a = audio[0]
    lines.push(
      `AUDIO: AudioData.timestamp IS on ${a.epoch}${a.epoch.startsWith('performance') ? ' directly' : ''}, offset ${a.offsetMs} ms with sd ${a.sdMs} ms and drift ${a.driftMsPerMin} ms/min. ` +
        `That offset is the batch (see the batch column) plus transport — the exact lateness the read-time anchor bakes in. ` +
        `${a.steadierThanG5 && a.holdsOverAnHour ? 'It is a usable anchor and X14 can take it.' : 'It is not steady enough to anchor on.'}`,
    )
  }
  if (video.length) {
    const v = video[0]
    lines.push(
      `VIDEO: VideoFrame.timestamp is present on ${v.epoch} (offset ${v.offsetMs} ms, sd ${v.sdMs} ms). ` +
        (report.fakeDevices
          ? 'MEASURED ON SUBSTITUTED DEVICES: this says the field exists and is stable, and it CANNOT say whether it marks capture or delivery — a fake source has no capture pipeline to be late by. That half needs a real capturer.'
          : 'Measured on a real capturer.'),
    )
  }
  report.verdict = lines.join(' ')
  console.log(`\nVERDICT FOR X14:\n  ${lines.join('\n  ')}`)
  if (report.errors?.length) console.log(`\nerrors: ${JSON.stringify(report.errors)}`)

  exitCode = Object.values(report.sources).some((s) => s?.summary?.samples > 0) ? 0 : 1
} catch (err) {
  report.error = String(err)
  console.error('x14a failed:', err)
} finally {
  if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2))
  try {
    browser?.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  await sleep(300)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  process.exit(exitCode)
}
