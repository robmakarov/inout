#!/usr/bin/env node
/**
 * O9(b) — DOES THE FULL-COLOUR FILE PLAY WHERE IT IS SENT? (2026-09-05)
 *
 * THE GATE THIS ANSWERS, written in O9's own row and left open since:
 * "plays at its destination: the 4:4:4 file decodes in Chrome (every score is
 * read off a decode); Safari is UNVERIFIED and is exactly why this is opt-in."
 * Robert asked for the colour default to move, so the unverified half had to
 * stop being unverified before anything flipped.
 *
 * IT IS TWO QUESTIONS AND BOTH NEED A REAL BROWSER.
 *
 *   1. WHAT CAN THIS MACHINE ENCODE? Real Chrome, WebCodecs, one config per
 *      4:4:4 rung — and `isConfigSupported` is not believed on its own (M4's
 *      rule: Chrome accepts configs it then does not honour), so every accepted
 *      config is ENCODED and the chunks are counted.
 *   2. WHAT DOES SAFARI DECODE? Real Safari through safaridriver, given actual
 *      files over http — and THREE INSTRUMENTS IN A ROW ANSWERED NOTHING before
 *      the fourth worked, which is why the method is written into the probe
 *      itself: `canPlayType` says "probably" for a file Safari cannot decode ·
 *      `readyState` reaches 4 on that same file · autoplay is refused for EVERY
 *      lane under WebDriver (no user gesture), so `currentTime` never advances
 *      and even plain H.264 grades itself failed. The verdict that works is a
 *      PIXEL: seek, draw the element into a canvas, count what came out.
 *
 * MEASURED 2026-09-05 on Robert's M3 (Chrome 152, Safari 26.6), two identical
 * readings — docs/qa/o9b-destination.json:
 *
 *   ENCODE   av1 4:4:4 YES · hevc 4:4:4 (Rext) NO · hevc 4:2:2 10-bit NO ·
 *            h264 High 4:4:4 Predictive NO · (controls hevc/avc 4:2:0 YES)
 *   DECODE   av1 4:4:4 PAINTS NOTHING (1 colour off a blank canvas) while
 *            canPlayType says "probably" · hevc 4:4:4 173 colours · hevc 4:2:0
 *            238 · avc 4:2:0 204 — the three controls prove the instrument
 *
 * So the only 4:4:4 the browser can make is the one Safari cannot play, and the
 * only 4:4:4 Safari plays is one the browser cannot make. That is the whole
 * reason the default did not move, and it is a browser wall, not a taste: the
 * same VideoToolbox that refuses us here takes `ayuv` from a native process
 * (ffmpeg -h encoder=hevc_videotoolbox), which is P4's argument in one line.
 *
 *   node scripts/o9b-destination.mjs [--keep]
 *
 * The A/B pair in ~/Downloads/inout-o9 is the source material (O9 made it); the
 * HEVC comparands are transcoded from it with ffmpeg so every lane is the same
 * pictures. --keep leaves the served directory in place for a second look.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeRetrying, quitChrome, resolveChrome } from './lib/chrome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const AB = join(process.env.HOME ?? '', 'Downloads', 'inout-o9')
const SERVE = join(tmpdir(), 'inout-o9b-destination')
const PORT = 8123
const KEEP = process.argv.includes('--keep')

/** The rungs worth asking about: every way this platform could store chroma per pixel. */
const ENCODE_CODECS = [
  ['hevc-444-8', 'hvc1.4.10.L153.B0'],
  ['hevc-444-8-hev1', 'hev1.4.10.L153.B0'],
  ['hevc-422-10', 'hvc1.4.10.L153.BD'],
  ['hevc-main-420', 'hvc1.1.6.L153.B0'],
  ['avc-444', 'avc1.f4002a'],
  ['avc-high-420', 'avc1.640028'],
  ['av1-444', 'av01.1.08M.08'],
]

const ENCODE_PAGE = (codecs) => `(async () => {
  const out = []
  for (const [name, codec] of ${JSON.stringify(codecs)}) {
    const cfg = { codec, width: 640, height: 360, bitrate: 4000000, framerate: 30 }
    const row = { name, codec, supported: false, accel: null, encoded: 0, bytes: 0, error: null }
    for (const accel of ['no-preference', 'prefer-hardware', 'prefer-software']) {
      try {
        const s = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: accel })
        if (s.supported) { row.supported = true; row.accel = accel; break }
      } catch (e) { row.error = String((e && e.message) || e) }
    }
    if (row.supported) {
      try {
        const sizes = []
        const enc = new VideoEncoder({
          output: (c) => sizes.push(c.byteLength),
          error: (e) => { row.error = 'encoder: ' + String((e && e.message) || e) },
        })
        enc.configure({ ...cfg, hardwareAcceleration: row.accel })
        const cv = new OffscreenCanvas(640, 360)
        const ctx = cv.getContext('2d')
        for (let i = 0; i < 12; i++) {
          ctx.fillStyle = 'rgb(' + i * 20 + ',30,200)'
          ctx.fillRect(0, 0, 640, 360)
          ctx.fillStyle = '#f0f'
          ctx.font = '20px monospace'
          ctx.fillText('frame ' + i + ' 4:4:4 probe', 20, 180)
          const f = new VideoFrame(cv, { timestamp: i * 33333, duration: 33333 })
          enc.encode(f, { keyFrame: i === 0 })
          f.close()
        }
        await enc.flush()
        enc.close()
        row.encoded = sizes.length
        row.bytes = sizes.reduce((a, b) => a + b, 0)
      } catch (e) { row.error = 'encode: ' + String((e && e.message) || e) }
    }
    out.push(row)
  }
  return JSON.stringify(out)
})()`

const SAFARI_PROBE = `
const done = arguments[arguments.length - 1]
;(async () => {
  const v = document.createElement('video')
  const canPlayType = {
    av1_444: v.canPlayType('video/mp4; codecs="av01.1.08M.08"'),
    hevc_444: v.canPlayType('video/mp4; codecs="hvc1.4.10.L153.B0"'),
    avc_420: v.canPlayType('video/mp4; codecs="avc1.640028"'),
  }
  const isTypeSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported
    ? { av1_444: MediaSource.isTypeSupported('video/mp4; codecs="av01.1.08M.08"') }
    : null
  // LOADING IS NOT PLAYING, AND PLAYING IS NOT ALLOWED. Two dead ends, both
  // measured, both kept here so nobody walks them again: Safari reaches
  // readyState 4 on a file it cannot decode (so readyState answers nothing), and
  // WebDriver has no user gesture, so autoplay is refused for EVERY file
  // including plain H.264 (so currentTime answers nothing either).
  //
  // THE VERDICT IS A PIXEL. Seek one frame in, draw the element into a canvas
  // and look at what came out: drawImage can only paint a frame the decoder
  // produced, and a decoder that failed paints nothing and leaves the canvas
  // uniform. The AVC lane is the control — if IT does not paint, the probe is
  // broken and no other row may be read.
  async function probe(id) {
    const el = document.getElementById(id)
    const r = { id, readyState: -1, w: 0, h: 0, error: null, seekedTo: 0, colours: 0 }
    await new Promise((res) => {
      let settled = false
      const fin = () => { if (!settled) { settled = true; res() } }
      el.addEventListener('loadeddata', fin, { once: true })
      el.addEventListener('error', fin, { once: true })
      setTimeout(fin, 8000)
      el.load()
    })
    r.readyState = el.readyState
    r.w = el.videoWidth
    r.h = el.videoHeight
    r.duration = el.duration
    if (el.error === null && el.duration > 0) {
      await new Promise((res) => {
        let settled = false
        const fin = () => { if (!settled) { settled = true; res() } }
        el.addEventListener('seeked', fin, { once: true })
        el.addEventListener('error', fin, { once: true })
        setTimeout(fin, 8000)
        el.currentTime = Math.min(1, el.duration / 2)
      })
      r.seekedTo = el.currentTime
      try {
        const cv = document.createElement('canvas')
        cv.width = 64
        cv.height = 36
        const ctx = cv.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(el, 0, 0, 64, 36)
        const px = ctx.getImageData(0, 0, 64, 36).data
        const seen = new Set()
        for (let i = 0; i < px.length; i += 4) {
          seen.add((px[i] >> 3) + ',' + (px[i + 1] >> 3) + ',' + (px[i + 2] >> 3))
        }
        r.colours = seen.size
      } catch (e) { r.drawError = String((e && e.message) || e) }
    }
    r.error = el.error ? { code: el.error.code, message: el.error.message } : null
    // One colour is a blank canvas: nothing was decoded into it.
    r.decodes = r.error === null && r.colours > 1
    return r
  }
  const rows = {}
  for (const id of ['av1_444', 'hevc_444', 'hevc_420', 'avc_420']) rows[id] = await probe(id)
  done({ ua: navigator.userAgent, canPlayType, isTypeSupported, files: rows })
})()
`

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function buildFiles() {
  if (!existsSync(join(AB, 'every-colour.mp4'))) {
    throw new Error(`O9's A/B pair is missing: ${AB}. Make it with scripts/o9-colour.mjs --ab.`)
  }
  rmSync(SERVE, { recursive: true, force: true })
  mkdirSync(SERVE, { recursive: true })
  sh('cp', [join(AB, 'every-colour.mp4'), join(SERVE, 'av1_444.mp4')])
  sh('cp', [join(AB, 'todays-export.mp4'), join(SERVE, 'avc_420.mp4')])
  // The same pictures through the two HEVC rungs, so a difference is the format
  // and never the content. libx265 is the only 4:4:4 HEVC encoder on this box —
  // it is here to ask Safari a question, and is not a shipping path.
  sh('ffmpeg', ['-y', '-v', 'error', '-i', join(SERVE, 'av1_444.mp4'), '-c:v', 'libx265',
    '-pix_fmt', 'yuv444p', '-crf', '20', '-tag:v', 'hvc1', join(SERVE, 'hevc_444.mp4')])
  sh('ffmpeg', ['-y', '-v', 'error', '-i', join(SERVE, 'av1_444.mp4'), '-c:v', 'hevc_videotoolbox',
    '-pix_fmt', 'yuv420p', '-q:v', '60', '-tag:v', 'hvc1', join(SERVE, 'hevc_420.mp4')])
  writeFileSync(
    join(SERVE, 'index.html'),
    `<!doctype html><meta charset=utf-8><title>o9b destination</title>` +
      ['av1_444', 'hevc_444', 'hevc_420', 'avc_420']
        .map((id) => `<video id=${id} src="${id}.mp4" muted playsinline></video>`)
        .join('\n'),
  )
  const probed = {}
  for (const id of ['av1_444', 'hevc_444', 'hevc_420', 'avc_420']) {
    probed[id] = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,profile,pix_fmt', '-of', 'default=nw=1:nk=0', join(SERVE, `${id}.mp4`)])
      .trim().split('\n').reduce((o, l) => { const [k, v] = l.split('='); o[k] = v; return o }, {})
  }
  return probed
}

async function askChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'inout-o9b-'))
  const session = await launchChromeRetrying({
    bin: resolveChrome(),
    profile,
    url: 'https://inout-kappa.vercel.app/?synthetic=1',
    headed: true,
  })
  try {
    for (let i = 0; i < 150; i++) {
      try {
        const o = await session.evaluate('location.origin + ":" + (typeof VideoEncoder)')
        if (String(o).includes('inout-kappa') && String(o).endsWith('function')) break
      } catch {
        /* context still swapping */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    const raw = await session.evaluate(ENCODE_PAGE(ENCODE_CODECS), 180_000)
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
  } finally {
    await quitChrome(session)
    rmSync(profile, { recursive: true, force: true })
  }
}

async function askSafari() {
  try {
    sh('sh', ['-c', `lsof -ti:${PORT} | xargs kill 2>/dev/null || true`])
  } catch {
    /* nothing was holding it */
  }
  const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: SERVE, stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 800))
    const probeFile = join(SERVE, 'probe.js')
    writeFileSync(probeFile, SAFARI_PROBE)
    const out = sh('node', [join(HERE, 'safari.mjs'), `http://localhost:${PORT}/`, probeFile])
    return JSON.parse(out.slice(out.indexOf('{')))
  } finally {
    server.kill()
  }
}

const files = buildFiles()
const encode = await askChrome()
const play = await askSafari()

const pad = (s, n) => String(s).padEnd(n)
console.log('\nCAN THIS CHROME ENCODE IT? (probed, then actually encoded)')
for (const r of encode) {
  console.log(
    `  ${pad(r.name, 16)} ${r.supported ? 'YES' : 'no '}  chunks=${pad(r.encoded, 3)} bytes=${pad(r.bytes, 7)}${r.error ? '  ' + r.error : ''}`,
  )
}
console.log('\nDOES SAFARI PLAY IT? (real files, real Safari)')
for (const [id, r] of Object.entries(play.files)) {
  console.log(
    `  ${pad(id, 16)} ${r.decodes ? 'DECODES' : 'FAILS  '} readyState=${r.readyState} seeked=${Number(r.seekedTo).toFixed(2)}s colours=${pad(r.colours, 4)} ${r.error ? 'ERROR ' + r.error.code + ' ' + r.error.message : ''}`,
  )
}
console.log(`\n  and Safari's canPlayType says: ${JSON.stringify(play.canPlayType)}`)

const out = {
  what: "O9(b)'s last open gate: does the full-colour file play where it is sent? Two real browsers, real files.",
  how: 'node scripts/o9b-destination.mjs',
  date: new Date().toISOString().slice(0, 10),
  headline:
    'THE ONLY 4:4:4 THIS BROWSER CAN ENCODE IS THE ONE SAFARI CANNOT DECODE, AND THE ONLY 4:4:4 SAFARI DECODES IS ONE THIS BROWSER CANNOT ENCODE. AV1 4:4:4 encodes in Chrome and paints a BLANK canvas in Safari 26.6 (1 colour against 173-238 on the three controls) while canPlayType answers "probably" and readyState reaches 4; HEVC 4:4:4 (Rext) decodes in Safari and is refused by WebCodecs here at every acceleration preference. So the full-colour file cannot become the blind-shared default from a browser — every Safari, iPhone and iPad recipient gets a black rectangle. VideoToolbox itself takes 4:4:4 (ayuv is in hevc_videotoolbox pixel formats), which is P4 native at maximum in one line.',
  method:
    'Two readings, identical. The three instruments that answered nothing first are in the script header so nobody re-walks them: canPlayType lies, readyState 4 is reached on an undecodable file, and WebDriver has no user gesture so autoplay is refused for every lane including plain H.264. The verdict is a decoded pixel.',
  files,
  encode,
  play,
}
mkdirSync(join(REPO, 'docs/qa'), { recursive: true })
writeFileSync(join(REPO, 'docs/qa/o9b-destination.json'), JSON.stringify(out, null, 1))
console.log('\nwrote docs/qa/o9b-destination.json')
if (!KEEP) rmSync(SERVE, { recursive: true, force: true })
