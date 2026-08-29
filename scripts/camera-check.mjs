#!/usr/bin/env node
/**
 * P9 — DOES A CAMERA-ONLY TAKE REALLY RECORD 1080p, OR IS IT A 720p UPSCALE?
 *
 * O3a claimed it fixed this: `cameraVideoConstraints` asks for 1920x1080 when a
 * take has no screen channel, because a camera-only take fills the whole frame
 * and a 720p source was being scaled up into a 1080p export — "visibly soft".
 * The claim has never been checked, and it CANNOT be checked the way everything
 * else in this repo is:
 *
 *   · synthetic mode bypasses getUserMedia entirely, so no rig can see it;
 *   · the oracle's camera is a painted canvas at whatever size it chose;
 *   · and Robert is right that eyes are the wrong instrument for a resolution.
 *
 * So this drives REAL Chrome against the REAL built-in camera on the DEPLOYED
 * build, and then reads the answer out of the FILES THEMSELVES rather than out
 * of the interface. `--use-fake-ui-for-media-stream` auto-grants the site
 * permission while keeping the actual device — the opposite of
 * `--use-fake-device-for-media-stream`, which would replace the camera with a
 * test pattern and answer a question nobody asked.
 *
 * WHY THE EXPORT'S OWN HEADER IS NOT THE ANSWER, and this is the part that
 * makes the test non-obvious: the export is 1920x1080 either way. The live
 * compositor COVER-FITS a camera-only take into its own fixed 1920x1080 canvas,
 * so a 720p camera produces a 1080p file that is 720p pixels stretched — which
 * is exactly the defect, wearing the header of the fix. The distinguishing
 * evidence is three things read together:
 *
 *   1. what the camera CAN do          (getCapabilities on the real device)
 *   2. what the track DELIVERED        (getSettings, and capture's own console)
 *   3. what the RAW CAMERA CHANNEL on disk actually holds (its own mp4 header)
 *
 * (3) is the one that cannot be faked by a scaler downstream, so it is the
 * gate. Everything is read out of OPFS, where the product already keeps every
 * channel, the composite and the finished export — no download plumbing, and
 * the same box parser reads all of them.
 *
 *   node scripts/camera-check.mjs
 *   node scripts/camera-check.mjs --headed --takeMs=8000
 *   node scripts/camera-check.mjs --url=http://localhost:4173/   # a local preview
 *
 * Exit code is 0 only when every gate passed. QA only: this script changes no
 * product code and the product cannot tell it apart from a user.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9349
const PROD_URL = 'https://inout-kappa.vercel.app/'

/** Everything downstream is 1920x1080 (acquire.ts CAPTURE_MAX_*, and the
 *  compositor's own canvas). A camera cannot usefully deliver more. */
const CEILING = { width: 1920, height: 1080 }

const CHROME = {
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

function resolveChrome() {
  for (const c of CHROME[process.platform] ?? []) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c
    } else {
      const found = which(c)
      if (found) return found
    }
  }
  return null
}

function parseArgs(argv) {
  // HEADED BY DEFAULT, and that is a measurement decision rather than a
  // convenience. Headless Chrome has no GPU here: the raw video channel's
  // MediaStreamTrackProcessor -> VideoEncoder path times out after 8 s and the
  // channel falls back to MediaRecorder VP9 — a different file, a different
  // codec, and a different answer to the question this test asks. Measured on
  // the first run of this script. `--headless` is kept for a machine with no
  // display, and the report says which mode produced it.
  const o = { url: PROD_URL, takeMs: 10_000, headed: true, out: null, bin: null, fakeDevice: false, noFakeUi: false }
  for (const a of argv) {
    if (a === '--headed') o.headed = true
    else if (a === '--headless') o.headed = false
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a.startsWith('--takeMs=')) o.takeMs = Number(a.slice(9))
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--bin=')) o.bin = a.slice(6)
    // THE CONTROL, and it is a diagnostic rather than a mode of the test.
    // Chrome's synthetic camera answers ONE question: is this script and this
    // build capable of producing the evidence at all? If the fake device flows
    // and the real one does not, the fault is the machine's camera and not the
    // product's — which is the distinction note 10 exists to force. A run with
    // this flag can never PASS P9; it says so in the report and exits non-zero.
    else if (a === '--fake-device') o.fakeDevice = true
    // Diagnostic: grant the site permission over CDP instead of with the
    // launch flag, in case the flag itself is what starves the real device.
    else if (a === '--no-fake-ui') o.noFakeUi = true
    else {
      console.error(`camera-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return o
}

// ---------------------------------------------------------------------------
// the MP4 box reader — ONE parser, used on every file this test looks at
// ---------------------------------------------------------------------------

/**
 * Pull a video track's real dimensions and the file's comment tag out of raw
 * MP4 bytes.
 *
 * Written as a self-contained function on purpose: it is `String()`-injected
 * into the page to read OPFS files, and called directly here for anything on
 * disk. Two copies of this logic would be two chances to disagree about the
 * one number the whole test turns on.
 *
 * TKHD carries the DISPLAY dimensions as 16.16 fixed point — what a player is
 * told to show. STSD's VisualSampleEntry carries the CODED dimensions — how
 * many pixels the encoder actually wrote. They differ exactly when something
 * scaled, which is the defect this test exists to catch, so both are reported
 * and the CODED pair is the one the gate reads.
 */
function readMp4(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (o) => dv.getUint32(o)
  const u16 = (o) => dv.getUint16(o)
  const type = (o) => String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
  const out = { container: null, tracks: [], comment: null, truncated: false }
  if (bytes.byteLength < 16) return out
  out.container = type(0) === 'ftyp' ? 'mp4' : bytes[0] === 0x1a && bytes[1] === 0x45 ? 'webm' : 'unknown'
  if (out.container !== 'mp4') return out

  /** Walk the boxes in [start, end), calling visit(type, payloadStart, payloadEnd). */
  const walk = (start, end, visit) => {
    let o = start
    while (o + 8 <= end) {
      let size = u32(o)
      const t = type(o)
      let header = 8
      if (size === 1) {
        // 64-bit size. Anything this test reads is far below 4 GB, so the high
        // word is ignored rather than pretended about.
        if (o + 16 > end) break
        size = u32(o + 12)
        header = 16
      } else if (size === 0) {
        size = end - o // "to end of file"
      }
      if (size < header || o + size > end) {
        out.truncated = true
        break
      }
      visit(t, o + header, o + size)
      o += size
    }
  }

  const readTrak = (s, e) => {
    const track = { handler: null, displayWidth: null, displayHeight: null, codedWidth: null, codedHeight: null, codec: null }
    walk(s, e, (t, ps, pe) => {
      if (t === 'tkhd') {
        const version = bytes[ps]
        // version/flags(4) + times&ids(24 or 32) + reserved/layer/volume(16) + matrix(36)
        const at = ps + 4 + (version === 1 ? 32 : 24) + 16 + 36
        if (at + 8 <= pe) {
          track.displayWidth = u32(at) / 65536
          track.displayHeight = u32(at + 4) / 65536
        }
      } else if (t === 'mdia') {
        walk(ps, pe, (t2, ps2, pe2) => {
          if (t2 === 'hdlr' && ps2 + 12 <= pe2) {
            track.handler = String.fromCharCode(bytes[ps2 + 8], bytes[ps2 + 9], bytes[ps2 + 10], bytes[ps2 + 11])
          } else if (t2 === 'minf') {
            walk(ps2, pe2, (t3, ps3, pe3) => {
              if (t3 !== 'stbl') return
              walk(ps3, pe3, (t4, ps4, pe4) => {
                if (t4 !== 'stsd') return
                // version/flags(4) + entry_count(4), then sample entries.
                walk(ps4 + 8, pe4, (sampleType, es, ee) => {
                  // VisualSampleEntry: reserved(6) dref(2) pre(2) res(2) pre(12) w(2) h(2)
                  if (es + 26 > ee) return
                  track.codec = sampleType
                  track.codedWidth = u16(es + 24)
                  track.codedHeight = u16(es + 26)
                })
              })
            })
          }
        })
      }
    })
    return track
  }

  walk(0, bytes.byteLength, (t, ps, pe) => {
    if (t !== 'moov') return
    walk(ps, pe, (t2, ps2, pe2) => {
      if (t2 === 'trak') out.tracks.push(readTrak(ps2, pe2))
      else if (t2 === 'udta') {
        walk(ps2, pe2, (t3, ps3, pe3) => {
          if (t3 !== 'meta') return
          // `meta` is a FULL box: skip its version/flags before its children.
          walk(ps3 + 4, pe3, (t4, ps4, pe4) => {
            if (t4 !== 'ilst') return
            walk(ps4, pe4, (t5, ps5, pe5) => {
              if (t5 !== '\u00A9cmt') return
              walk(ps5, pe5, (t6, ps6, pe6) => {
                // data box: version/flags(4) + locale(4) + the UTF-8 payload.
                if (t6 !== 'data' || ps6 + 8 > pe6) return
                out.comment = new TextDecoder().decode(bytes.subarray(ps6 + 8, pe6))
              })
            })
          })
        })
      }
    })
  })

  if (!out.comment) {
    // The tag layout is the muxer's business and it has changed before. The
    // certification is self-identifying, so a scan is a legitimate fallback —
    // and saying which way it was found keeps the evidence honest.
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const at = text.indexOf('{"app":"inout"')
    if (at >= 0) {
      let depth = 0
      for (let i = at; i < text.length && i < at + 4096; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}' && --depth === 0) {
          out.comment = text.slice(at, i + 1)
          out.commentFoundByScan = true
          break
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2))
const bin = opts.bin ?? resolveChrome()
if (!bin) {
  console.error(JSON.stringify({ error: 'Google Chrome is not installed on this machine', platform: process.platform }, null, 2))
  process.exit(3)
}

const profile = mkdtempSync(join(tmpdir(), 'inout-cam-'))
const report = {
  task: 'P9 camera-1080-verify',
  ranAt: new Date().toISOString(),
  url: opts.url,
  platform: process.platform,
  chrome: bin,
  chromeVersion: (() => {
    try {
      return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    } catch {
      return null
    }
  })(),
  headless: !opts.headed,
  fakeDevice: opts.fakeDevice,
  takeMs: opts.takeMs,
  camera: { device: null, capabilities: null, settings: null, error: null },
  captureLog: [],
  otherLog: [],
  consoleErrors: [],
  files: [],
  certification: null,
  gates: {},
}
let browser
let exitCode = 1

try {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // THE REAL DEVICE, auto-granted. Not --use-fake-device-for-media-stream,
    // which would substitute a test pattern and answer nothing.
    ...(opts.noFakeUi ? [] : ['--use-fake-ui-for-media-stream']),
    ...(opts.fakeDevice ? ['--use-fake-device-for-media-stream'] : []),
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--mute-audio',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  args.push(opts.url)
  browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws = null
  for (let i = 0; i < 200 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.startsWith(new URL(opts.url).origin))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {}
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
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (m.params.type === 'error') report.consoleErrors.push(text)
      else if (text.startsWith('[capture') || text.startsWith('[compose') || text.startsWith('[bits'))
        report.captureLog.push(text)
      // Everything else, capped — a take that goes wrong usually says so
      // somewhere other than the two prefixes this test cares about, and the
      // first three runs of this script were all diagnosed from lines it was
      // throwing away.
      else if (report.otherLog.length < 120) report.otherLog.push(`${m.params.type}: ${text}`)
    } else if (m.method === 'Runtime.exceptionThrown') {
      report.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    // Every page-side call is bounded for the same reason: a media promise that
    // never settles must fail this run loudly, not stall it silently.
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page evaluate timed out after 30s')), 30_000)),
    ])
    return r.result.value
  }
  /** CDP hands back a string OR an already-decoded value depending on the
   *  shape; accept both rather than stringifying an object into "[object
   *  Object]" and then failing to parse it — which is what the first run did. */
  const evalJson = async (expression, fallback) => {
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
  await send('Browser.grantPermissions', {
    origin: new URL(opts.url).origin,
    permissions: ['videoCapture', 'audioCapture'],
  }).catch(() => undefined)

  await sleep(2500)
  report.gates.boots = !!(await evaluate(`!!document.querySelector('button[aria-label="Start recording"]')`))
  if (!report.gates.boots) throw new Error('the app did not reach the capture screen')

  // ---- PRE-FLIGHT: CAN THIS MACHINE ANSWER THE QUESTION AT ALL? ------------
  // getUserMedia resolving is NOT evidence that a camera works. A track can
  // open, report settings of exactly 1920x1080@30, and then deliver NOTHING —
  // which is precisely what happened on the first three runs of this script,
  // and what `[capture] camera delivering 0.0 fps` in the take was reporting
  // from the other end. So the frames are COUNTED here, before the take, and a
  // camera that yields none makes this run say it could not measure rather
  // than reporting a take full of zeroes as a product failure.
  const cam = await evalJson(
    `(async () => {
      const probe = async (deviceId) => {
        const video = { width: { ideal: 1920 }, height: { ideal: 1080 } }
        if (deviceId) video.deviceId = { exact: deviceId }
        const s = await navigator.mediaDevices.getUserMedia({ video })
        const t = s.getVideoTracks()[0]
        const caps = t.getCapabilities ? t.getCapabilities() : null
        const settings = t.getSettings()
        // WARM THE SOURCE FIRST, AND THIS IS THE WHOLE FIX. A processor opened
        // on a just-acquired track counted ZERO frames from Chrome's synthetic
        // camera — a source that provably records a full take — because the
        // pipeline had not started producing yet. An earlier version of this
        // probe accidentally worked by spending three seconds on a video
        // element's play() before it began counting. Doing it on purpose:
        // attach a sink, give it time, then count.
        const warm = document.createElement('video')
        warm.srcObject = s
        warm.muted = true
        warm.playsInline = true
        document.body.appendChild(warm)
        await Promise.race([warm.play().catch(() => {}), new Promise((r) => setTimeout(r, 2000))])
        await new Promise((r) => setTimeout(r, 1200))
        let frames = 0
        let firstFrameSize = null
        let probeError = null
        if (typeof MediaStreamTrackProcessor === 'function') {
          try {
            // ON THE TRACK ITSELF, not a clone. A clone read this way returned
            // ZERO frames even from Chrome's synthetic camera — the one source
            // that provably records — so the clone was the fault and not the
            // device. The stream is stopped immediately after, so nothing else
            // wanted this track anyway.
            const reader = new MediaStreamTrackProcessor({ track: t }).readable.getReader()
            const deadline = Date.now() + 2500
            for (;;) {
              const left = deadline - Date.now()
              if (left <= 0) break
              const next = await Promise.race([
                reader.read(),
                new Promise((r) => setTimeout(() => r({ timeout: true }), left)),
              ])
              if (next.timeout || next.done) break
              frames++
              if (!firstFrameSize) firstFrameSize = { width: next.value.displayWidth, height: next.value.displayHeight }
              next.value.close()
            }
            await reader.cancel().catch(() => {})
          } catch (e) { probeError = String(e) }
        } else {
          probeError = 'MediaStreamTrackProcessor is absent in this browser'
        }
        const label = t.label
        const sawVideoSize = { width: warm.videoWidth, height: warm.videoHeight }
        warm.remove()
        for (const tr of s.getTracks()) tr.stop()
        return { deviceId: deviceId ?? null, label, caps, settings, frames, firstFrameSize: firstFrameSize ?? (sawVideoSize.width ? sawVideoSize : null), probeError, previewSize: sawVideoSize }
      }
      try {
        // EVERY CAMERA ON THE MACHINE IS TRIED, not just the default. This Mac
        // has two (a built-in FaceTime and a Continuity iPhone), and a lid-shut
        // or otherwise dormant built-in enumerates, negotiates 1920x1080@30 and
        // stays live while delivering nothing — so 'the default camera' is not
        // the same question as "a camera".
        const first = await probe(null)
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
        const tried = [first]
        for (const d of cams) {
          if (first.frames >= 10) break
          if (tried.some((x) => x.label === d.label)) continue
          try { tried.push(await probe(d.deviceId)) } catch (e) { tried.push({ deviceId: d.deviceId, label: d.label, error: String(e) }) }
        }
        const live = tried.find((x) => (x.frames ?? 0) >= 10) ?? first
        return JSON.stringify({
          label: live.label, caps: live.caps, settings: live.settings,
          framesIn3000ms: live.frames, videoSize: live.firstFrameSize,
          readyState: 'live', muted: false, processorError: live.probeError ?? null,
          chosenDeviceId: live.deviceId,
          probed: tried.map((x) => ({ label: x.label, frames: x.frames ?? null, settings: x.settings ? x.settings.width + 'x' + x.settings.height : null, error: x.error ?? null })),
          devices: cams.map((d) => ({ label: d.label, deviceId: d.deviceId.slice(0, 8) })),
        })
      } catch (e) { return JSON.stringify({ error: String(e && e.name ? e.name + ': ' + e.message : e) }) }
    })()`,
    {},
  )
  const camInfo = cam ?? {}
  report.camera = {
    device: camInfo.label ?? null,
    devices: camInfo.devices ?? null,
    capabilities: camInfo.caps ?? null,
    settings: camInfo.settings ?? null,
    framesIn3000ms: camInfo.framesIn3000ms ?? null,
    firstFrameSize: camInfo.videoSize ?? null,
    processorError: camInfo.processorError ?? null,
    chosenDeviceId: camInfo.chosenDeviceId ?? null,
    probed: camInfo.probed ?? null,
    decodedFrames: camInfo.decodedFrames ?? null,
    videoSize: camInfo.videoSize ?? null,
    trackReadyState: camInfo.readyState ?? null,
    trackMuted: camInfo.muted ?? null,
    error: camInfo.error ?? null,
  }
  // THE PRECONDITION, and it is a gate rather than a crash: a camera that
  // opens but never yields a frame cannot answer P9, and saying so is the
  // honest outcome. Every gate below it is left unmeasured on purpose.
  // A HANDFUL OF FRAMES IS NOT A WORKING CAMERA. At 30 fps a live device
  // delivers ~90 in three seconds; the earlier <video> probe scored a single
  // spurious callback off a stream that produced nothing, and a `> 0` bar
  // passed it. Ten is far below any real camera and far above that noise.
  report.gates.cameraDeliversFrames = (report.camera.framesIn3000ms ?? 0) >= 10
  if (!report.gates.cameraDeliversFrames) {
    report.cannotMeasure =
      `THE CAMERA OPENED AND DELIVERED NOTHING. It negotiated ` +
      `${report.camera.settings?.width}x${report.camera.settings?.height}@${report.camera.settings?.frameRate}, the track stayed live and unmuted, ` +
      `and ${report.camera.framesIn3000ms} frames arrived in 3 s through MediaStreamTrackProcessor — the very API capture reads. ` +
      `getUserMedia resolving is not evidence that a camera works, and every video input on this machine was tried: ` +
      `${(report.camera.probed ?? []).map((p) => `${p.label} → ${p.frames} frames`).join(' · ') || 'none'}. ` +
      `THE LIKELIEST CAUSE IS A CLOSED LID: a MacBook in clamshell still enumerates its built-in camera, still negotiates a resolution, and still reports the track live, ` +
      `while the sensor is off. Same signature from another app holding the device, or from the OS camera permission for the Chrome binary ` +
      `(System Settings > Privacy & Security > Camera) — which the --use-fake-ui-for-media-stream flag cannot grant, because that flag answers the SITE prompt and not the OS one. ` +
      `NOTHING ABOUT THE PRODUCT IS BEING MEASURED HERE. Run \`node scripts/camera-check.mjs --fake-device\` to confirm the harness itself still works, ` +
      `and re-run this with a live camera to finish P9.`
  }

  // ---- CAMERA ONLY. A screen channel would need a picker no flag can answer,
  // and it is also the wrong take: the 1080p constraint only applies when there
  // is no screen (acquire.ts cameraVideoConstraints).
  // THE FIRST RUN OF THIS SCRIPT SET THE CHIPS AND REPORTED WHAT IT INTENDED,
  // not what happened — and what happened was a screen+camera+mic take that
  // spent 18 s waiting for a microphone. A toggle is a React state change, so
  // it is set, re-read, and retried; the report carries the state the app
  // ACTUALLY ended in, and a gate fails if it is not camera-only.
  report.chips = await evalJson(
    `(async () => {
      const want = { Screen: false, Camera: true, Mic: false, 'Tab Audio': false }
      const read = () => {
        const out = {}
        for (const b of document.querySelectorAll('.chips button')) {
          out[b.getAttribute('title') || b.textContent.trim()] = b.getAttribute('aria-pressed') === 'true'
        }
        return out
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const now = read()
        let clicked = false
        for (const b of document.querySelectorAll('.chips button')) {
          const name = b.getAttribute('title') || b.textContent.trim()
          if (!(name in want)) continue
          if (now[name] !== want[name] && !b.disabled) { b.click(); clicked = true; break }
        }
        if (!clicked) break
        await new Promise((r) => setTimeout(r, 250))
      }
      return JSON.stringify(read())
    })()`,
    null,
  )
  report.gates.cameraOnlyConfig =
    !!report.chips && report.chips.Camera === true &&
    report.chips.Screen === false && report.chips.Mic === false && report.chips['Tab Audio'] === false

  await sleep(600)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(opts.takeMs)
  report.gates.recorded = !!(await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  ))
  // POLLED, NOT SLEPT. The first headed run gave the stop 4 s and missed it:
  // a camera channel's own encoder flush can outlast the session's 5 s
  // recorder-stop budget on a cold device, and a fixed sleep then reads an
  // empty manifest and reports it as an empty take.
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('.editor')`)) break
    await sleep(500)
  }
  report.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
  // …and the manifest is written after the editor mounts, so give the take's
  // own channels a moment to appear before anything reads them.
  await sleep(1500)

  // ---- export, so the finished file lands in OPFS beside the channels -------
  await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(1000)
  await evaluate(`(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`)
  let meta = null
  for (let i = 0; i < 240 && !meta; i++) {
    await sleep(500)
    meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
  }
  report.exportMeta = meta
  report.gates.exported = !!meta

  // ---- AND NOW THE FILES THEMSELVES ----------------------------------------
  // Everything the product made for this take is in OPFS: every raw channel,
  // the composite, and the finished export. The header of each is read with
  // the same parser, in the page, so nothing has to travel as base64.
  const opfs = await evaluate(`(async () => {
    const readMp4 = ${String(readMp4)};
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('blobs')
    const out = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue
      const file = await handle.getFile()
      // The moov of a fragmented MP4 sits at the front; 512 KB is generous
      // headroom and keeps a long take from being read into memory here.
      const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer())
      const parsed = readMp4(head)
      out.push({ name, bytes: file.size, ...parsed })
    }
    return JSON.stringify(out)
  })()`)
  report.files = Array.isArray(opfs) ? opfs : JSON.parse(opfs || '[]')

  // ---- AND WHAT THE PRODUCT ITSELF WROTE DOWN ------------------------------
  // ChannelRecording.width/height, straight out of IndexedDB. A third
  // independent witness beside the track settings and the file header: if the
  // product's own record disagrees with the bytes on disk, that is a finding of
  // its own and not something to average away.
  report.recorded = await evalJson(
    `(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('inout')
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
        durationMs: rec.durationMs,
        channels: rec.channels.map((c) => ({
          kind: c.kind, media: c.media, mimeType: c.mimeType,
          width: c.width ?? null, height: c.height ?? null,
          blobKey: c.blobKey, durationMs: c.durationMs,
        })),
        composite: rec.composite
          ? { width: rec.composite.width, height: rec.composite.height, engine: rec.composite.engine, blobKey: rec.composite.blobKey }
          : null,
      })
    })()`,
    null,
  )

  // ---- the gates -----------------------------------------------------------
  const videoOf = (f) => f.tracks?.find((t) => t.handler === 'vide') ?? null
  // Named by the product's own manifest, not by guessing at a key pattern.
  const cameraKey = report.recorded?.channels?.find((c) => c.kind === 'camera' && c.media === 'video')?.blobKey
  const cameraFile =
    (cameraKey && report.files.find((f) => f.name === cameraKey)) ||
    report.files.find((f) => /_ch_/.test(f.name) && videoOf(f))
  const exportFile = report.files.find((f) => f.name.startsWith('xport-'))
  const compositeFile = report.files.find((f) => f.name.includes('_composite'))
  report.picked = {
    cameraChannel: cameraFile?.name ?? null,
    export: exportFile?.name ?? null,
    composite: compositeFile?.name ?? null,
  }

  const caps = report.camera.capabilities
  const capMaxW = caps?.width?.max ?? null
  const capMaxH = caps?.height?.max ?? null
  const offers1080 = capMaxW !== null && capMaxH !== null && capMaxW >= CEILING.width && capMaxH >= CEILING.height
  // What the camera SHOULD have delivered: its own maximum, capped at ours.
  const expect = offers1080
    ? { width: CEILING.width, height: CEILING.height }
    : capMaxW && capMaxH
      ? { width: Math.min(capMaxW, CEILING.width), height: Math.min(capMaxH, CEILING.height) }
      : null
  report.cameraOffers1080 = offers1080
  report.expectedDelivered = expect

  const delivered = report.camera.settings
  const camVideo = cameraFile ? videoOf(cameraFile) : null
  const expVideo = exportFile ? videoOf(exportFile) : null

  report.gates.cameraReachable = !report.camera.error && !!caps
  report.gates.cameraChannelOnDisk = !!camVideo
  // THE GATE. O3a's claim is about the pixels the camera channel HOLDS, and a
  // coded size is the one number no downstream scaler can fabricate.
  report.gates.rawChannelIsCameraMax =
    !!camVideo && !!expect && camVideo.codedWidth === expect.width && camVideo.codedHeight === expect.height
  report.gates.exportIsFullFrame =
    !!expVideo && expVideo.codedWidth === CEILING.width && expVideo.codedHeight === CEILING.height
  // The defect O3a fixed, stated as its own gate so a regression names itself:
  // a 1080p file whose source was 720p is a stretch, not a recording.
  report.gates.exportIsNotAnUpscale =
    !!camVideo && !!expVideo && camVideo.codedWidth >= expVideo.codedWidth && camVideo.codedHeight >= expVideo.codedHeight
  report.gates.deliveredMatchesFile =
    !!camVideo && !!delivered && delivered.width === camVideo.codedWidth && delivered.height === camVideo.codedHeight
  // The product's own record must agree with the bytes it wrote. A mismatch is
  // not a rounding difference — it means the manifest describes a file that
  // does not exist, which every downstream consumer trusts.
  const recCam = report.recorded?.channels?.find((c) => c.kind === 'camera' && c.media === 'video') ?? null
  report.gates.manifestMatchesFile =
    !!camVideo && !!recCam && recCam.width === camVideo.codedWidth && recCam.height === camVideo.codedHeight
  report.gates.noConsoleErrors = report.consoleErrors.length === 0

  const cert = exportFile?.comment ?? null
  report.certification = (() => {
    try {
      return cert ? JSON.parse(cert) : null
    } catch {
      return null
    }
  })()
  report.gates.fileCarriesCertification = !!report.certification

  report.summary = {
    cameraOffers: capMaxW && capMaxH ? `${capMaxW}x${capMaxH}` : 'unknown',
    delivered: delivered ? `${delivered.width}x${delivered.height}@${Math.round(delivered.frameRate ?? 0)}` : null,
    rawCameraChannel: camVideo ? `${camVideo.codedWidth}x${camVideo.codedHeight} ${camVideo.codec}` : null,
    exportedFile: expVideo ? `${expVideo.codedWidth}x${expVideo.codedHeight} ${expVideo.codec}` : null,
    productRecorded: recCam ? `${recCam.width}x${recCam.height} ${recCam.mimeType}` : null,
    exportCopiedFrom: report.certification?.copiedFrom ?? null,
    captureSaid: report.captureLog.find((l) => l.includes('measured video camera')) ?? null,
  }

  const failed = Object.entries(report.gates).filter(([, v]) => !v).map(([k]) => k)
  report.failed = failed
  if (opts.fakeDevice) {
    // A synthetic camera cannot answer "does the real camera record 1080p".
    // The run is still worth everything it printed — it proves the harness —
    // but it is never a pass and the file must not be filed as one.
    report.verdict = failed.length === 0 ? 'HARNESS-OK (fake device — NOT a P9 answer)' : 'HARNESS-FAIL (fake device)'
    exitCode = 1
  } else if (!report.gates.cameraDeliversFrames) {
    report.verdict = 'CANNOT MEASURE'
    exitCode = 2
  } else {
    report.verdict = failed.length === 0 ? 'PASS' : 'FAIL'
    exitCode = failed.length === 0 ? 0 : 1
  }
} catch (err) {
  report.verdict = 'ERROR'
  report.error = err instanceof Error ? err.message : String(err)
} finally {
  console.log(JSON.stringify(report, null, 2))
  // The fake-device control is filed under its own name: it is evidence about
  // the HARNESS, and a file that overwrote the real-device answer with it would
  // be the most misleading artifact this task could produce.
  const out =
    opts.out ??
    join(ROOT, 'docs/qa', `camera-1080-${new Date().toISOString().slice(0, 10)}${opts.fakeDevice ? '-harness' : ''}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report, null, 2))
  console.error(`camera-check: ${report.verdict} — evidence written to ${out}`)
  try {
    browser?.kill('SIGKILL')
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  process.exit(exitCode)
}
