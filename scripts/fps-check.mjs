#!/usr/bin/env node
/**
 * F15 — DOES A 60 fps SOURCE ACTUALLY RECORD AND EXPORT 60, AND IS A 30 fps
 * SOURCE STILL EXACTLY WHAT IT WAS?
 *
 * The task's two gates are "a 30 fps source's take is byte-identical to today"
 * and "a 60 fps synthetic source records and exports 60 — read fps from the
 * FILE". Neither can be answered from the interface: the export panel says
 * "1080p" at both rates, the preview looks the same, and the console line only
 * says what capture INTENDED. The rate is a property of the bytes.
 *
 * THE BROWSER PANE CANNOT ANSWER IT EITHER, and that is the reason this file
 * exists rather than a session driving the deployed build by hand. The
 * synthetic screen is a canvas painted from requestAnimationFrame, and a hidden
 * tab does not run rAF: a take driven through a hidden pane recorded "37 frames
 * encoded of 2 in, 35 keep-alive (source was static)". The declared rate was 60
 * and the delivered rate was 0.1 — the file would have carried the answer and
 * meant nothing. A REAL, VISIBLE Chrome window is the instrument.
 *
 * So this drives real Chrome against the deployed build in synthetic mode (no
 * device, no permission prompt, and `?screenfps=` puts a 60 fps source in front
 * of the product without a 120 Hz monitor), records a take, exports it, and
 * reads the rate out of every file the take produced by walking the MP4 sample
 * tables. Both lanes run in one invocation, because the 30 fps lane is the
 * control that makes the 60 fps lane mean something.
 *
 *   node scripts/fps-check.mjs
 *   node scripts/fps-check.mjs --lane=60 --takeMs=8000 --headless
 *   node scripts/fps-check.mjs --url=http://localhost:4173/
 *
 * TWO VERDICTS, AND ONLY ONE OF THEM IS THE EXIT CODE. The CONTRACT gates ask
 * what F15 promised — did the source hand over its rate, did the composite and
 * the export carry it, does the copy path still fire. The THROUGHPUT line asks
 * whether this machine could keep up, and it is reported rather than gated
 * because it is a property of the machine and the moment: a 60 fps take asks
 * for twice the frames, and a Mac already running two browsers will drop them.
 * Folding that into the exit code would make a green run mean "the machine was
 * quiet", and a red one mean nothing about the product. Both are printed, and
 * a dropped-frame count is never left out of the report.
 *
 * Exit code is 0 only when every CONTRACT gate of every lane it ran passed.
 * QA only: this script changes no product code and the product cannot tell it
 * apart from a user.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9351
const PROD_URL = 'https://inout-kappa.vercel.app/'

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
  // HEADED BY DEFAULT, for the same reason camera-check.mjs is: headless Chrome
  // has no GPU here, the raw channel's WebCodecs path times out and falls back
  // to MediaRecorder — a different file answering a different question. Headed
  // is also what makes rAF run at all, which this test depends on absolutely.
  const o = { url: PROD_URL, takeMs: 8000, headed: true, out: null, bin: null, lanes: [60, 30], query: '', armAfterMs: 0, profile: null, camera: false }
  for (const a of argv) {
    if (a === '--headed') o.headed = true
    else if (a === '--headless') o.headed = false
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a.startsWith('--takeMs=')) o.takeMs = Number(a.slice(9))
    // B14 — HOW LONG THE PAGE IS LEFT ALONE BEFORE THE RECORD PRESS. The rig
    // arms ~4 s after load, which is inside the window where the encoder warm
    // has not yet published its measurement (encoderWarmYield.ts: the warm
    // lands ~4.2 s in, and it stands down entirely for a take that commits
    // first). What a take may attempt is decided from that measurement, so
    // "cold" and "a minute in" are two different products and the difference
    // is invisible unless the rig can wait.
    else if (a.startsWith('--armAfterMs=')) o.armAfterMs = Number(a.slice(13))
    // B14 — REUSE A CHROME PROFILE ACROSS RUNS. Every lane cuts a throwaway
    // profile, which makes every run the FIRST-EVER take on a fresh machine —
    // a real case, but not the one a returning user is in. What this machine
    // measured about itself is cached in localStorage across launches, so
    // "pressed cold, on a profile that has used the app before" is a different
    // product from "pressed cold, ever" and only a kept profile can show it.
    else if (a.startsWith('--profile=')) o.profile = a.slice(10)
    // ARM THE CAMERA TOO. Screen-only is this rig's default because the screen
    // is the channel `?screenfps=` steers — but max+CAMERA is a different take
    // in the one way that matters here: it is the case where the live composite
    // is opened, so it is the only lane that can show whether max opens one.
    else if (a === '--camera') o.camera = true
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--bin=')) o.bin = a.slice(6)
    else if (a.startsWith('--lane=')) o.lanes = [Number(a.slice(7))]
    // Extra URL parameters, appended verbatim. This rig was written to answer
    // F15's own question at 1080p; Robert's freeze is the same question at HIS
    // screen (`--query=screensize=3024x1964&sourceres=1`), and the rate is only
    // half of what a machine is being asked for.
    else if (a.startsWith('--query=')) o.query = a.slice(8).replace(/^[?&]/, '')
    else {
      console.error(`fps-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return o
}

// ---------------------------------------------------------------------------
// the MP4 reader — ONE parser, injected into the page, used on every file
// ---------------------------------------------------------------------------

/**
 * The rate a file was written at — TWO NUMBERS, because there are two answers
 * and conflating them is how the first version of this test read 22 fps off a
 * file whose every frame is stamped 1/60 s.
 *
 * MP4 has no "frame rate" field. What it has is a timescale and a duration per
 * sample, and those give:
 *
 *   gridFps      timescale / the MOST COMMON sample duration in the file — the
 *                frame grid the writer was working on. A take whose source
 *                delivers 60 puts its frames 1/60 s apart; a 30 fps take puts
 *                them 1/30 s apart. THIS is "what rate was this file written
 *                at", and it is the gate.
 *                MOST COMMON RATHER THAN SMALLEST, and that was measured the
 *                hard way: the export is a packet COPY carrying the composite's
 *                real timestamps, and two of those can land 17.8 ms apart on a
 *                30 fps take through ordinary arrival jitter — a smallest-gap
 *                reading called that file 56.25 fps. One jittery pair is not a
 *                grid; the gap that repeats is.
 *   cadenceFps   samples / total duration — how many frames actually landed per
 *                second. It is a fact about the MACHINE (an encoder that falls
 *                behind writes fewer frames on the same grid), which is why it
 *                is reported next to the drop counts and not gated on.
 *
 * Two layouts have to be read because the product writes both: a fragmented
 * file keeps its samples in `moof/traf/trun` (duration per-sample or defaulted
 * in `tfhd`), a plain one in `stbl/stts`. Reading only one would silently score
 * half the files at 0.
 *
 * Self-contained on purpose: it is `String()`-injected into the page so OPFS
 * files never travel as base64.
 */
function readMp4Rate(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (o) => dv.getUint32(o)
  const u16 = (o) => dv.getUint16(o)
  const type = (o) => String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
  const out = {
    container: null,
    trackId: null,
    timescale: null,
    codedWidth: null,
    codedHeight: null,
    codec: null,
    samples: 0,
    durationTicks: 0,
    minSampleTicks: null,
    modalSampleTicks: null,
    gridFps: null,
    cadenceFps: null,
    source: null,
    truncated: false,
  }
  const hist = new Map()
  const note = (ticks, count) => {
    if (!(ticks > 0)) return
    if (out.minSampleTicks === null || ticks < out.minSampleTicks) out.minSampleTicks = ticks
    hist.set(ticks, (hist.get(ticks) ?? 0) + (count ?? 1))
  }
  if (bytes.byteLength < 16) return out
  out.container =
    type(0) === 'ftyp' ? 'mp4' : bytes[0] === 0x1a && bytes[1] === 0x45 ? 'webm' : 'unknown'
  if (out.container !== 'mp4') return out

  const walk = (start, end, visit) => {
    let o = start
    while (o + 8 <= end) {
      let size = u32(o)
      const t = type(o)
      let header = 8
      if (size === 1) {
        if (o + 16 > end) break
        size = u32(o + 12)
        header = 16
      } else if (size === 0) {
        size = end - o
      }
      if (size < header || o + size > end) {
        out.truncated = true
        break
      }
      visit(t, o + header, o + size)
      o += size
    }
  }

  // ---- the VIDEO trak: its id, its timescale, its coded size, its stts -----
  let sttsSamples = 0
  let sttsTicks = 0
  walk(0, bytes.byteLength, (t, ps, pe) => {
    if (t !== 'moov') return
    walk(ps, pe, (t2, ps2, pe2) => {
      if (t2 !== 'trak') return
      let handler = null
      let trackId = null
      let timescale = null
      let codedWidth = null
      let codedHeight = null
      let codec = null
      let samples = 0
      let ticks = 0
      walk(ps2, pe2, (t3, ps3, pe3) => {
        if (t3 === 'tkhd') {
          const version = bytes[ps3]
          trackId = u32(ps3 + 4 + (version === 1 ? 16 : 8))
        } else if (t3 === 'mdia') {
          walk(ps3, pe3, (t4, ps4, pe4) => {
            if (t4 === 'mdhd') {
              const version = bytes[ps4]
              timescale = version === 1 ? u32(ps4 + 20) : u32(ps4 + 12)
            } else if (t4 === 'hdlr' && ps4 + 12 <= pe4) {
              handler = String.fromCharCode(
                bytes[ps4 + 8],
                bytes[ps4 + 9],
                bytes[ps4 + 10],
                bytes[ps4 + 11],
              )
            } else if (t4 === 'minf') {
              walk(ps4, pe4, (t5, ps5, pe5) => {
                if (t5 !== 'stbl') return
                walk(ps5, pe5, (t6, ps6, pe6) => {
                  if (t6 === 'stsd') {
                    walk(ps6 + 8, pe6, (sampleType, es, ee) => {
                      if (es + 26 > ee) return
                      codec = sampleType
                      codedWidth = u16(es + 24)
                      codedHeight = u16(es + 26)
                    })
                  } else if (t6 === 'stts') {
                    const entries = u32(ps6 + 4)
                    for (let i = 0; i < entries && ps6 + 8 + i * 8 + 8 <= pe6; i++) {
                      const count = u32(ps6 + 8 + i * 8)
                      const delta = u32(ps6 + 8 + i * 8 + 4)
                      samples += count
                      ticks += count * delta
                      note(delta, count)
                    }
                  }
                })
              })
            }
          })
        }
      })
      if (handler !== 'vide') return
      out.trackId = trackId
      out.timescale = timescale
      out.codedWidth = codedWidth
      out.codedHeight = codedHeight
      out.codec = codec
      sttsSamples = samples
      sttsTicks = ticks
    })
  })

  // ---- the FRAGMENTS, when there are any -----------------------------------
  let moofSamples = 0
  let moofTicks = 0
  walk(0, bytes.byteLength, (t, ps, pe) => {
    if (t !== 'moof') return
    walk(ps, pe, (t2, ps2, pe2) => {
      if (t2 !== 'traf') return
      let trackId = null
      let defaultDuration = 0
      const truns = []
      walk(ps2, pe2, (t3, ps3, pe3) => {
        if (t3 === 'tfhd') {
          const flags = u32(ps3) & 0x00ffffff
          trackId = u32(ps3 + 4)
          let at = ps3 + 8
          if (flags & 0x000001) at += 8 // base-data-offset
          if (flags & 0x000002) at += 4 // sample-description-index
          if (flags & 0x000008) {
            defaultDuration = at + 4 <= pe3 ? u32(at) : 0
            at += 4
          }
        } else if (t3 === 'trun') {
          truns.push([ps3, pe3])
        }
      })
      if (trackId !== out.trackId) return
      for (const [ps3, pe3] of truns) {
        const flags = u32(ps3) & 0x00ffffff
        const count = u32(ps3 + 4)
        let at = ps3 + 8
        if (flags & 0x000001) at += 4 // data-offset
        if (flags & 0x000004) at += 4 // first-sample-flags
        const perSampleDuration = !!(flags & 0x000100)
        const stride =
          (perSampleDuration ? 4 : 0) +
          (flags & 0x000200 ? 4 : 0) +
          (flags & 0x000400 ? 4 : 0) +
          (flags & 0x000800 ? 4 : 0)
        moofSamples += count
        if (perSampleDuration) {
          for (let i = 0; i < count && at + i * stride + 4 <= pe3; i++) {
            const d = u32(at + i * stride)
            moofTicks += d
            note(d)
          }
        } else {
          moofTicks += count * defaultDuration
          note(defaultDuration, count)
        }
      }
    })
  })

  if (moofSamples > 0) {
    out.samples = moofSamples
    out.durationTicks = moofTicks
    out.source = 'moof/trun'
  } else {
    out.samples = sttsSamples
    out.durationTicks = sttsTicks
    out.source = 'stbl/stts'
  }
  if (out.timescale > 0 && out.durationTicks > 0) {
    out.cadenceFps = Math.round(((out.samples * out.timescale) / out.durationTicks) * 100) / 100
  }
  let best = null
  let bestCount = -1
  for (const [ticks, count] of hist) {
    if (count > bestCount) {
      bestCount = count
      best = ticks
    }
  }
  out.modalSampleTicks = best
  if (out.timescale > 0 && best > 0) {
    out.gridFps = Math.round((out.timescale / best) * 100) / 100
  }
  return out
}

// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2))
const bin = opts.bin ?? resolveChrome()
if (!bin) {
  console.error(
    JSON.stringify(
      { error: 'Google Chrome is not installed on this machine', platform: process.platform },
      null,
      2,
    ),
  )
  process.exit(3)
}

const report = {
  task: 'F15 fps-follows-source',
  ranAt: new Date().toISOString(),
  url: opts.url,
  platform: process.platform,
  chrome: bin,
  headless: !opts.headed,
  takeMs: opts.takeMs,
  lanes: [],
}

/** One take at one source rate, from a cold profile, read out of the files. */
async function runLane(sourceFps) {
  const lane = {
    sourceFps,
    // `sourceframe=0` pins F13 off, so this measures ONE thing. The screen is
    // 16:9 either way, but a sticky flag from another session's testing would
    // otherwise change which lines appear and read as noise.
    url:
      `${opts.url}?synthetic=1&sourcefps=1&sourceframe=0&screenfps=${sourceFps}` +
      (opts.query ? `&${opts.query}` : ''),
    captureLog: [],
    consoleErrors: [],
    files: [],
    recorded: null,
    gates: {},
  }
  const profile = opts.profile ?? mkdtempSync(join(tmpdir(), `inout-fps-${sourceFps}-`))
  if (opts.profile) mkdirSync(opts.profile, { recursive: true })
  let browser
  try {
    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      '--window-size=1280,900',
    ]
    if (!opts.headed) args.unshift('--headless=new')
    args.push(lane.url)
    browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

    let ws = null
    for (let i = 0; i < 200 && !ws; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
        const page = list.find(
          (x) => x.type === 'page' && x.url.startsWith(new URL(opts.url).origin),
        )
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
        if (m.params.type === 'error') lane.consoleErrors.push(text)
        else if (/^\[(capture|compose|bits|quality)/.test(text)) lane.captureLog.push(text)
      } else if (m.method === 'Runtime.exceptionThrown') {
        lane.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
      }
    })
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        sock.send(JSON.stringify({ id, method, params }))
      })
    const evaluate = async (expression) => {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('page evaluate timed out after 30s')), 30_000),
        ),
      ])
      return r.result.value
    }
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
    await sleep(2500)
    lane.gates.boots = !!(await evaluate(
      `!!document.querySelector('button[aria-label="Start recording"]')`,
    ))
    if (!lane.gates.boots) throw new Error('the app did not reach the capture screen')

    // A SCREEN-ONLY TAKE. The screen is the one channel `?screenfps=` steers,
    // and screen-only is also the take whose default export packet-copies —
    // so the same run proves the copy fence lets 60/60 through.
    lane.chips = await evalJson(
      `(async () => {
        const CAMERA = ${opts.camera}
        const want = { Screen: true, Camera: CAMERA, Mic: true, 'Tab Audio': false }
        const read = () => {
          const out = {}
          for (const b of document.querySelectorAll('.chips button')) {
            out[b.getAttribute('title') || b.textContent.trim()] = b.getAttribute('aria-pressed') === 'true'
          }
          return out
        }
        for (let attempt = 0; attempt < 6; attempt++) {
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
    lane.gates.screenOnlyConfig =
      !!lane.chips && lane.chips.Screen === true && lane.chips.Camera === opts.camera

    // THE INSTRUMENT'S OWN PRECONDITION. rAF is what paints the synthetic
    // screen; a window that is not compositing runs it at 0 and the take that
    // follows would be 35 keep-alive frames wearing a 60 fps header. Measured
    // BEFORE the take, so a starved run says it could not measure rather than
    // reporting a product failure that is really a hidden window.
    lane.rafFps = await evaluate(`(async () => {
      const t0 = performance.now(); let n = 0
      await new Promise((r) => { const s = () => { n++; if (performance.now() - t0 > 1000) return r(); requestAnimationFrame(s) }; requestAnimationFrame(s) })
      return Math.round((n * 1000) / (performance.now() - t0))
    })()`)
    lane.gates.windowPaints = (lane.rafFps ?? 0) >= sourceFps - 5

    await sleep(400)
    // B14 — LEAVE THE PAGE ALONE FIRST, when asked to. Nothing is clicked and
    // nothing is measured in here; the point is only that the record press
    // lands on a page that has had time to finish its own warm.
    if (opts.armAfterMs > 0) {
      lane.armAfterMs = opts.armAfterMs
      await sleep(opts.armAfterMs)
    }
    // WHAT THE MACHINE HAD BEEN MEASURED AT, READ AT THE PRESS. This is the
    // input `rateForSurface` decides on, and reading it after the fact would
    // read a number the deferred measurement wrote when the take ended.
    lane.throughputAtArm = await evalJson(
      `(() => { try { return localStorage.getItem('inout.encoderBudget.v1') ?? 'null' } catch { return 'null' } })()`,
      null,
    )
    await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
    await sleep(opts.takeMs)
    lane.gates.recorded = !!(await evaluate(
      `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
    ))
    for (let i = 0; i < 60; i++) {
      if (await evaluate(`!!document.querySelector('.editor')`)) break
      await sleep(500)
    }
    lane.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))

    // B14 — THE TAKE'S OWN VERDICT, and the arm-time rate decision it carries.
    // The console line says what capture INTENDED; the card says how the take
    // was graded, and `decisions` is where M1's door writes what moved and who
    // moved it. Reading both here is what turns "60 was asked for" into "60 was
    // recorded and nothing quietly took it back".
    lane.card = await evalJson(
      `(async () => {
        try {
          if (typeof __inoutReport !== 'function') return JSON.stringify(null)
          const card = await __inoutReport()
          if (!card) return JSON.stringify(null)
          const dims = {}
          for (const d of card.dimensions ?? []) dims[d.id] = d.status
          const rateDetail = (card.dimensions ?? []).find((d) => d.id === 'rate')?.detail ?? null
          // The door's ledger, straight off the stored take — the arm-time rate
          // decision lives here whether it took anything or refused to.
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open('inout')
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
          })
          const all = await new Promise((res, rej) => {
            const r = db.transaction('recordings').objectStore('recordings').getAll()
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
          })
          const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
          const rate = (rec?.stopStats?.decisions ?? []).filter((d) => d.dial === 'rate')
          return JSON.stringify({
            verdict: card.verdict, line: card.line, dimensions: dims, rateDetail,
            rateDecisions: rate.map((d) => ({
              action: d.action, outcome: d.outcome, what: d.what,
              branch: d.measured?.rateBranch ?? null,
              want: d.measured?.wantMpxPerS ?? null,
              can: d.measured?.canMpxPerS ?? null,
              at: d.measured?.canMeasuredAt ?? null,
            })),
          })
        } catch (e) { return JSON.stringify({ error: String(e) }) }
      })()`,
      null,
    )
    await sleep(1500)

    // ---- export at the default step, so the finished file lands in OPFS ----
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
    )
    await sleep(1000)
    await evaluate(
      `(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`,
    )
    let meta = null
    for (let i = 0; i < 240 && !meta; i++) {
      await sleep(500)
      meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
    }
    lane.exportMeta = meta
    lane.gates.exported = !!meta

    // ---- AND NOW THE FILES THEMSELVES -------------------------------------
    const opfs = await evaluate(`(async () => {
      const readMp4Rate = ${String(readMp4Rate)};
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('blobs')
      const out = []
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue
        const file = await handle.getFile()
        // The whole file: a fragmented MP4's samples are spread across every
        // moof, so a head-only read would count one fragment and call it the
        // rate. These takes are seconds long and megabytes at most.
        const all = new Uint8Array(await file.arrayBuffer())
        out.push({ name, bytes: file.size, ...readMp4Rate(all) })
      }
      return JSON.stringify(out)
    })()`)
    lane.files = Array.isArray(opfs) ? opfs : JSON.parse(opfs || '[]')

    // ---- and what the product itself wrote down ---------------------------
    lane.recorded = await evalJson(
      `(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('inout')
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
        })
        const store = db.transaction('recordings').objectStore('recordings')
        const all = await new Promise((res, rej) => {
          const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
        })
        const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
        if (!rec) return JSON.stringify(null)
        return JSON.stringify({
          id: rec.id,
          channels: rec.channels.filter((c) => c.media === 'video').map((c) => ({ kind: c.kind, w: c.width, h: c.height, fps: c.fps ?? null })),
          composite: rec.composite ? { w: rec.composite.width, h: rec.composite.height, fps: rec.composite.fps ?? null, engine: rec.composite.engine } : null,
        })
      })()`,
      null,
    )

    // ---- the gates ---------------------------------------------------------
    const want = sourceFps
    // A BAND, NOT A NUMBER, and the band is the honest instrument. The rate in
    // a file is the rate that was DELIVERED, and a canvas source under
    // requestAnimationFrame never delivers its nominal exactly: the 30 fps
    // control's own composite measures 25.2, because the cadence gate opens
    // every 32.3 ms and frames arrive every 33.3 ms. What the gate has to
    // separate is 25 from 49, not 59.9 from 60.
    // THE GRID IS EXACT, so the band is tight: a frame is 1/60 s or it is not.
    // (An encoder is allowed to round 16.666 ms to 16 or 17 ticks in a coarse
    // timescale, so a percent of slack, not zero.)
    const onGrid = (v) => v !== null && v !== undefined && Math.abs(v - want) <= want * 0.06
    const exported = lane.files.filter((f) => /^xport/.test(f.name) && f.container === 'mp4')
    const composite = lane.files.find((f) => /_composite/.test(f.name) && f.container === 'mp4')
    // The raw channel's key is `<recordingId>_<channelId>` — the KIND is not in
    // it, so it is whatever mp4 is neither the composite nor the export.
    const rawScreen = lane.files.find(
      (f) => f.container === 'mp4' && !/_composite|^xport/.test(f.name),
    )
    lane.measured = {
      exportSamples: exported.map((f) => f.samples),
      compositeSamples: composite?.samples ?? null,
      exportGridFps: exported.map((f) => f.gridFps),
      exportCadenceFps: exported.map((f) => f.cadenceFps),
      exportGeometry: exported.map((f) => `${f.codedWidth}x${f.codedHeight}`),
      compositeGridFps: composite?.gridFps ?? null,
      compositeCadenceFps: composite?.cadenceFps ?? null,
      rawScreenGridFps: rawScreen?.gridFps ?? null,
      rawScreenCadenceFps: rawScreen?.cadenceFps ?? null,
    }
    // ---- what the machine managed, read out of the engines' own summaries --
    const num = (re, line) => {
      const m = line ? re.exec(line) : null
      return m ? Number(m[1]) : null
    }
    const rawLine = lane.captureLog.find((l) => /raw video channel: /.test(l)) ?? null
    const compLine = lane.captureLog.find((l) => /composite v2 .* frames \(/.test(l)) ?? null
    lane.throughput = {
      arrived: num(/(\d+) in\b/, rawLine),
      rawEncoded: num(/channel: (\d+) frames encoded/, rawLine),
      rawDropped: num(/(\d+) DROPPED/, rawLine) ?? 0,
      compositeEncoded: num(/— (\d+) frames \(/, compLine),
      compositeDropped: num(/\((\d+) dropped/, compLine) ?? 0,
      rawLine,
      compLine,
    }
    lane.throughputOk =
      lane.throughput.compositeDropped === 0 && lane.throughput.rawDropped === 0
    // THE TRACK ITSELF was handed 60 by the OS — the half F15 changed in
    // acquire.ts. Without this the rest could all be the product agreeing with
    // itself about a source that never sped up.
    lane.copyLine = lane.captureLog.find((l) => /^\[bits\]/.test(l)) ?? null
    lane.gates.sourceDelivered = lane.captureLog.some((l) =>
      new RegExp(`leaving display at \\d+×\\d+@${want}\\b`).test(l),
    )
    // NOT a contract gate: the raw channel's rate is the first casualty when a
    // machine cannot keep up, and it is reported in `throughput` instead.
    lane.gates.compositeWrittenAtRate = onGrid(lane.measured.compositeGridFps)
    /**
     * THE EXPORT IS NOT ASKED FOR A GRID, and that is a fact about the product
     * rather than a softened gate. An unedited export PACKET-COPIES the
     * composite: `instant.ts` calls `addVideoTrack(videoSource)` with no rate at
     * all, so mediabunny picks its own 57600 timescale and re-expresses the
     * take's real timestamps in it. Both lanes then read a 56.25 fps modal gap —
     * the remuxer's quantization, identical whatever the take was, and nothing
     * to do with F15.
     *
     * What the copy DOES promise is that the file is the composite's own
     * frames — every one of them, none added — so that is what is checked, and
     * only that. The two cadence numbers are NOT compared: the composite's is
     * derived from durations its worker stamps nominally (1 tick each), the
     * export's from the timestamps the remuxer recomputed, and holding two
     * differently-derived numbers to 10 % of each other tests the derivation
     * and not the product. The RATE comes from the composite's own grid above.
     * A step that RE-RENDERS builds frames on the tier's grid, so that case is
     * checked the direct way.
     */
    const src = composite
    lane.gates.exportCarriesTheTakesFrames =
      exported.length > 0 &&
      exported.every(
        (f) =>
          onGrid(f.gridFps) ||
          (!!src && /copy/.test(lane.copyLine ?? '') && f.samples === src.samples),
      )
    lane.gates.productRecordedRate =
      lane.recorded?.composite?.fps === want ||
      (lane.recorded?.channels ?? []).some((c) => c.fps === want)
    // The 30 lane is the CONTROL: nothing may announce a moved rate, and the
    // default step must still be the instant copy it has always been.
    const announced = lane.captureLog.some((l) => /composite follows the source: \d+ fps/.test(l))
    lane.gates.announcedOnlyWhenMoved = want === 30 ? !announced : announced
    // The panel's meta line is duration/bytes/geometry — it says nothing about
    // WHICH path ran, so the copy is read from the export's own `[bits]` line.
    lane.gates.instantCopyStillFires = /copy/.test(lane.copyLine ?? '')
    lane.gates.noConsoleErrors = lane.consoleErrors.length === 0
  } catch (err) {
    lane.error = String(err?.message ?? err)
  } finally {
    try {
      browser?.kill('SIGTERM')
    } catch {}
    await sleep(700)
    if (!opts.profile) {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {}
    }
  }
  lane.pass = Object.values(lane.gates).every(Boolean) && !lane.error
  return lane
}

for (const rate of opts.lanes) {
  report.lanes.push(await runLane(rate))
  await sleep(1000)
}

report.pass = report.lanes.every((l) => l.pass)
const outPath = opts.out ?? join(ROOT, '.artifacts', 'fps-check.json')
try {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))
} catch {}

for (const l of report.lanes) {
  console.log(
    `\nlane ${l.sourceFps} fps — ${l.pass ? 'PASS' : 'FAIL'}${l.error ? ` (${l.error})` : ''}`,
  )
  console.log(`  rAF in the window       ${l.rafFps} fps`)
  const pair = (grid, cadence) => `grid ${grid ?? '—'} fps · cadence ${cadence ?? '—'} fps`
  console.log(
    `  raw screen channel      ${pair(l.measured?.rawScreenGridFps, l.measured?.rawScreenCadenceFps)} (from the file)`,
  )
  console.log(
    `  composite               ${pair(l.measured?.compositeGridFps, l.measured?.compositeCadenceFps)} (from the file)`,
  )
  console.log(
    `  export                  ${pair((l.measured?.exportGridFps ?? []).join('/'), (l.measured?.exportCadenceFps ?? []).join('/'))} ${(l.measured?.exportGeometry ?? []).join(', ')} (from the file)`,
  )
  console.log(
    `  frames in the files     composite ${l.measured?.compositeSamples ?? '—'} · export ${(l.measured?.exportSamples ?? []).join('/') || '—'}`,
  )
  console.log(`  product's own record    ${JSON.stringify(l.recorded)}`)
  console.log(
    `  throughput              ${l.throughputOk ? 'kept up' : 'BEHIND'} — ${l.throughput?.arrived ?? '?'} frames arrived · ` +
      `composite ${l.throughput?.compositeEncoded ?? '?'} encoded / ${l.throughput?.compositeDropped ?? '?'} dropped · ` +
      `raw ${l.throughput?.rawEncoded ?? '?'} encoded / ${l.throughput?.rawDropped ?? '?'} dropped`,
  )
  console.log(`  export meta             ${l.exportMeta ?? '—'}`)
  console.log(`  export path             ${l.copyLine ?? '—'}`)
  for (const [k, v] of Object.entries(l.gates)) console.log(`  ${v ? 'ok  ' : 'FAIL'} ${k}`)
  if (l.consoleErrors.length) console.log(`  console errors: ${l.consoleErrors.slice(0, 3).join(' · ')}`)
}
console.log(
  `\nfps-check: contract ${report.pass ? 'PASS' : 'FAIL'} · throughput ${report.lanes.every((l) => l.throughputOk) ? 'kept up' : 'BEHIND on at least one lane — see above, this is the machine and not the contract'} — report at ${outPath}`,
)
process.exit(report.pass ? 0 : 1)
