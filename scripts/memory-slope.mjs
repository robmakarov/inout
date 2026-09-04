#!/usr/bin/env node
/**
 * H3 — DOES A TAKE'S MEMORY GO UP FOREVER? One cell, one command.
 *
 * Nothing in this repo measures memory past minutes. S1's report card reads a
 * POINT SAMPLE at stop and says so; the rate ladder watches frames, not bytes.
 * So "perfect record unlimited length" has never been checked against the thing
 * that actually ends a long take on an 8 GB machine — the memory it holds.
 *
 * ONE SOAK: a synthetic max60 take on the deployed build, sampled once a
 * minute, stopped properly at the end, graded by the product's own report card.
 *
 * WHAT IS SAMPLED, AND WHY IT IS NOT `performance.memory`. The JS heap is the
 * smaller half of the story and the less interesting one: decoded frames,
 * encoder buffers and GPU-backed VideoFrames live OUTSIDE it, which is exactly
 * how R2's GPU-process kill stayed invisible to every in-page counter for three
 * sessions. So every sample takes three readings —
 *   · RSS per Chrome process off the OS, grouped by Chrome's own --type=
 *     (renderer / gpu-process / utility / browser), which is the number the
 *     machine runs out of;
 *   · the renderer's JS heap over CDP (JSHeapUsedSize), and its Nodes,
 *     Documents and JSEventListeners, because a DOM leak looks like nothing in
 *     RSS until it looks like everything;
 *   · what the take is DOING — delivered fps off its own console, and bytes
 *     written — so a flat curve produced by a take that quietly died is caught
 *     rather than reported as a pass.
 *
 * THE BAND IS DECLARED HERE, BEFORE THE RUN, and a leak found is its own task
 * rather than a reason to widen it (the task's own gate):
 *   · RSS slope after warm-up  < 5 MB/min   (an hour of 5 MB/min is 300 MB)
 *   · JS heap slope after warm-up < 1 MB/min
 *   · the take is still recording at the last sample
 * Warm-up is the first 5 minutes, discarded on purpose: arming, the encoder
 * warm-up and the first keyframes are not the slope anybody is asking about.
 *
 *   node scripts/memory-slope.mjs                      # 60 min, the H3 cell
 *   node scripts/memory-slope.mjs --minutes=10         # a short rehearsal
 *   node scripts/memory-slope.mjs --screen=2560x1440   # a heavier synthetic source
 *   node scripts/memory-slope.mjs --real               # THE MAX60 CELL: the real
 *                                                      # display, the only source
 *                                                      # that survives it (G8)
 *   node scripts/memory-slope.mjs --tab                # THE SAME CELL WITH TAB
 *                                                      # AUDIO IN IT — the only
 *                                                      # lane whose card can be
 *                                                      # green on `channels` on
 *                                                      # macOS (see `TAB_TITLE`)
 *
 * HEAVY: announce it, and do not run it while the machine is in use. Exit code
 * is 0 only when every band above held.
 *
 * IT DID NOT STALL AT MAX — THE TAB DIED AND NOTHING COULD SAY SO (G8, fixed
 * 2026-09-04). The 2026-09-04 night run printed its header and nothing else for
 * 11 and 20 minutes at `--screen=3024x1964`, and the row written from it said
 * the RIG stalls at max. Measured since, three runs out of three: the take's
 * renderer CRASHES 14-28 s after the record press (`Inspector.targetCrashed`,
 * browser-target status "crashed", errorCode 5 = the renderer's own abort), and
 * the rig then waited on `Performance.getMetrics` — the one call in the sample
 * loop that had no timeout — for as long as anyone let it. So the silence was
 * this file's, and the crash is the finding underneath it (G8's row).
 * FIXED HERE AND IN lib/chrome.mjs: every CDP call is bounded, a crashed target
 * is recorded once and fails every later call instantly, the sleep between
 * samples wakes on a death, and the run ends within ~2 s of one with
 * `takeSurvived:false`, `crashedAtMinute` and the console tail in the report.
 *
 * A KILLED RUN LEAVES A CHROME THAT BLOCKS THE NEXT ONE. The browser is spawned
 * detached, so killing the node process (or the gate wrapper) orphans it: one
 * sat at 0 % CPU for 68 minutes, and the NEXT invocation then never got a
 * browser at all. Kill by profile, not by script name: the profile is
 * `inout-h3-<pid>` under the temp dir, and nothing else matches it. This applies
 * to every headed rig here, not just this one.
 *
 * QA only: changes no product code, and the product cannot tell it from a user.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  chromeRss,
  launchChromeRetrying,
  quitChrome,
  resolveChrome,
  sleep,
} from './lib/chrome.mjs'

const PROD_URL = 'https://inout-kappa.vercel.app/'
const BAND = { rssMbPerMin: 5, heapMbPerMin: 1, warmupMin: 5 }

function parseArgs(argv) {
  const o = {
    url: PROD_URL,
    minutes: 60,
    sampleMs: 60_000,
    screen: '1920x1080',
    screenFps: 60,
    headed: true,
    out: null,
    keepProfile: false,
    real: false,
    source: 'Entire screen',
    /** THE TAB LANE (see the note above `tabArgs`): capture a TAB instead of
     *  the whole screen, which is the only way macOS gives Chrome the system
     *  audio Phase 1's own criterion asks for. */
    tab: false,
  }
  for (const a of argv) {
    if (a === '--headed') o.headed = true
    else if (a === '--headless') o.headed = false
    else if (a === '--keep-profile') o.keepProfile = true
    else if (a === '--real') o.real = true
    else if (a === '--tab') {
      o.real = true
      o.tab = true
      o.source = TAB_TITLE
    }
    else if (a.startsWith('--source=')) o.source = a.slice(9)
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a.startsWith('--minutes=')) o.minutes = Number(a.slice(10))
    else if (a.startsWith('--sampleMs=')) o.sampleMs = Number(a.slice(11))
    else if (a.startsWith('--screen=')) o.screen = a.slice(9)
    else if (a.startsWith('--screenfps=')) o.screenFps = Number(a.slice(12))
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else {
      console.error(`memory-slope: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(o.minutes) || o.minutes < 1) {
    console.error(`memory-slope: --minutes=${o.minutes} is not a soak`)
    process.exit(2)
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))
const bin = resolveChrome()
if (!bin) {
  console.error('memory-slope: Chrome not found — set CHROME_BIN')
  process.exit(2)
}

/**
 * The take under test: the `max` step, which is what turns the source's own
 * resolution and 60 fps on (docs/FLAGS.md).
 *
 * `--real` TAKES THE SYNTHETIC SOURCE OUT, AND AT MAX IT IS THE ONLY CELL THAT
 * SURVIVES (G8, measured 2026-09-04). A canvas `captureStream` hands the take
 * **BGRA** frames — 23.7 MB each at 3024x1964, converted for the encoder on
 * every one — where a real display hands **NV12** straight off the compositor at
 * 8.9 MB, which is what both takes' own console lines say they got. At
 * 3024x1964@60 the synthetic cell kills the tab 14-28 s after the press, four
 * runs out of four, while the real display at the SAME size and rate ran 120 s
 * with RSS flat at 350-460 MB, 6059 frames encoded, and a card at the end. So
 * the soak's own source was the thing that could not afford max — the product
 * can. Below max the synthetic source is fine and stays the default: 1920x1080
 * runs clean.
 *
 * The cost of `--real`: macOS gives Chrome no system audio, so the tab-audio
 * channel of the Phase-1 criterion is missing and the card is RED on `channels`.
 * `--tab` is the lane that fixes it — it captures a TAB, which Chrome does hand
 * the audio of, and it is built here rather than left as a note.
 *
 * fps-check.mjs's own `--real` note says whole-screen capture on macOS is
 * "refused by the OS in 641 ms". That is true of a node-SPAWNED Chrome, whose
 * TCC grant is attributed to node; it is not true here, because this lane comes
 * up through `open -na` (lib/chrome.mjs's `viaOpen`, the same route
 * gpu-residency.mjs uses). Measured working 2026-09-04: NV12 3024x1964 frames,
 * 6059 encoded in 115.9 s, card written.
 */
function takeUrl(url) {
  const u = new URL(url)
  u.searchParams.set('qstep', 'max')
  if (!opts.real) {
    u.searchParams.set('synthetic', '1')
    u.searchParams.set('screensize', opts.screen)
    u.searchParams.set('screenfps', String(opts.screenFps))
  }
  return u.toString()
}

/**
 * THE TAB LANE — the last gap in Phase 1's own "done means" cell.
 *
 * The criterion is two ≥60-min max60 takes with camera + TAB AUDIO graded
 * GREEN. `--real` captures the whole screen, and macOS gives Chrome no system
 * audio off a whole-screen capture at all — so that lane's card is RED on
 * `channels` for a reason no amount of soaking will change. The roadmap named
 * the answer and left it unbuilt: capture a TAB instead, where Chrome supplies
 * the tab's own audio.
 *
 * So this opens a second tab that MAKES A SOUND — a self-contained page with a
 * WebAudio oscillator on it, as a `data:` URL so the lane needs no server and
 * no network — gives it a title nothing else can match, and answers the picker
 * with that title. It is the same recipe as the screen lane, pointed at a
 * different surface.
 *
 * WHY A TONE AND NOT SILENCE: a silent tab hands the take an audio track that
 * never delivers a byte, which grades the same as no tab audio at all and would
 * make this lane a more elaborate way of failing the same gate.
 *
 * The window is sized to the display so the captured tab is the display's own
 * pixels — a max60 take of a 400x300 tab is not the take Phase 1 is asking
 * about.
 */
const TAB_TITLE = 'INOUT SOAK TONE'

/**
 * THE PAGE IS WRITTEN TO A FILE AND OPENED WITH `file://`, NOT HANDED OVER AS A
 * `data:` URL. Chrome has refused top-level navigation to `data:` since 60, and
 * `Target.createTarget` goes through the same navigation path — so the tab would
 * have come up blank, the picker would have matched nothing, and the run would
 * have died an hour in for a reason that has nothing to do with the take. Same
 * reason `proto/style.html` is opened off disk (CLAUDE.md).
 */
const TONE_HTML =
  `<!doctype html><meta charset=utf-8><title>${TAB_TITLE}</title>` +
  `<body style="margin:0;background:#111;color:#eee;font:14px system-ui">` +
  `<p id=s style="padding:12px">soak tone: starting</p><script>` +
  // A 440 Hz sine at -26 dBFS: audible to the tap, quiet enough that an hour of
  // it is not a torture test of the limiter.
  `const c=new AudioContext();` +
  `const o=c.createOscillator(),g=c.createGain();` +
  `o.type='sine';o.frequency.value=440;g.gain.value=0.05;o.connect(g);g.connect(c.destination);o.start();` +
  // The text moves every second on purpose: a still page is a compressible one,
  // and this lane is meant to cost the encoder something.
  `setInterval(()=>{if(c.state!=='running')c.resume();` +
  `document.getElementById('s').textContent='soak tone '+c.state+' '+new Date().toISOString();},1000);` +
  `<\/script></body>`

/** Chrome's own picker automation, so `getDisplayMedia` is answered by a switch
 *  rather than by a native dialog nothing can reach. Same recipe, same reasons,
 *  as gpu-residency.mjs — including why it is NOT --use-fake-ui-for-media-stream. */
const realArgs = () => [
  `--auto-select-desktop-capture-source=${opts.source}`,
  // The tab-specific switch is newer than the desktop one and is what actually
  // answers the picker with a TAB on current Chrome; an unknown switch is
  // ignored, so passing both costs the screen lane nothing.
  ...(opts.tab
    ? [
        `--auto-select-tab-capture-source-by-title=${opts.source}`,
        // An AudioContext with no user gesture behind it comes up SUSPENDED, so
        // the tone tab would be silent and this lane would be a more elaborate
        // way of failing the same `channels` gate it exists to pass.
        '--autoplay-policy=no-user-gesture-required',
      ]
    : []),
  '--auto-accept-this-tab-capture',
  '--disable-features=InfiniteSessionRestore,ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac',
]

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

/** Least-squares slope of y over x, plus how much of y it explains. */
function fit(points) {
  const n = points.length
  if (n < 3) return { slope: null, r2: null, n }
  const mx = points.reduce((a, p) => a + p.x, 0) / n
  const my = points.reduce((a, p) => a + p.y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my)
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  return { slope, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy), n }
}

const PAGE_SAMPLE = `(async () => {
  const m = performance.memory ?? null
  let usage = null
  try { usage = (await navigator.storage.estimate()).usage ?? null } catch (e) {}
  return JSON.stringify({
    recording: !!${STOP_BTN},
    heapUsed: m ? m.usedJSHeapSize : null,
    heapTotal: m ? m.totalJSHeapSize : null,
    heapLimit: m ? m.jsHeapSizeLimit : null,
    storageUsage: usage,
  })
})()`

const report = {
  task: 'H3',
  url: takeUrl(opts.url),
  headed: opts.headed,
  source: opts.tab
    ? `a real TAB ("${opts.source}"), which is what gives macOS Chrome the tab audio`
    : opts.real
      ? `the real display (${opts.source})`
      : `synthetic ${opts.screen}@${opts.screenFps}`,
  minutes: opts.minutes,
  band: BAND,
  startedAt: new Date().toISOString(),
  samples: [],
  card: null,
}

console.error(
  `memory-slope: HEAVY — ${opts.minutes} min soak, sampled every ${(opts.sampleMs / 1000).toFixed(0)} s · ` +
    `${opts.headed ? 'HEADED' : 'HEADLESS'} · source: ${report.source} · ${report.url}`,
)

const profile = join(tmpdir(), `inout-h3-${process.pid}`)
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

/** A STAGE THAT TAKES A MINUTE MUST STILL SAY IT STARTED. The first sample is a
 *  whole minute after the press, so an unbroken silence used to be the same
 *  console output as a dead run — which is exactly how G8's stall was misread. */
const runStart = Date.now()
const step = (s) => console.error(`memory-slope: [${((Date.now() - runStart) / 1000).toFixed(1)}s] ${s}`)

let session
let exitCode = 1
try {
  session = await launchChromeRetrying({
    bin,
    profile,
    url: takeUrl(opts.url),
    headed: opts.headed,
    extraArgs: opts.real ? realArgs() : [],
    // A node-spawned Chrome is denied macOS Screen Recording (TCC attributes to
    // the responsible process), so the real source has to come up under `open`.
    viaOpen: opts.real && process.platform === 'darwin',
  })
  step('chrome up, CDP attached')
  if (opts.real) {
    await session
      .send('Browser.grantPermissions', { origin: new URL(opts.url).origin, permissions: ['videoCapture', 'audioCapture'] })
      .catch(() => step('camera/mic permission refused — the take will say which channels it lost'))
  }
  // Without this, getMetrics answers with an empty list and every DOM counter
  // reads null — which looks exactly like "nothing leaked" (rehearsal, H3).
  await session.send('Performance.enable').catch(() => undefined)
  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline && !ready) {
    ready = !!(await session.evaluate(`!!${START_BTN}`))
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('the app never reached the capture screen')
  step('capture screen ready')

  if (opts.tab) {
    /**
     * THE SURFACE BEING CAPTURED HAS TO EXIST BEFORE THE PRESS. The picker is
     * answered by title, so the tone tab is opened first and given a moment to
     * put its title up; without that the switch matches nothing and
     * getDisplayMedia comes back with the screen or with nothing at all.
     *
     * The window is sized to the display so a max60 take of this tab is the
     * display's own pixels — Chrome's own bounds, not CSS, which is why this
     * goes through Browser.setWindowBounds rather than window.resizeTo.
     */
    const tonePath = join(profile, 'soak-tone.html')
    writeFileSync(tonePath, TONE_HTML)
    const { targetId } = await session.send('Target.createTarget', {
      url: pathToFileURL(tonePath).href,
      background: true,
    })
    report.toneTab = targetId
    report.tonePage = tonePath
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget', {})
      const screen = await session.evalJson(
        `JSON.stringify({ w: screen.width, h: screen.height })`,
        null,
      )
      if (screen) {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left: 0, top: 0, width: screen.w, height: screen.h, windowState: 'normal' },
        })
        report.windowSizedTo = screen
      }
    } catch (err) {
      step(`window could not be sized (${String(err)}) — the take is still valid, just smaller`)
    }
    await sleep(2000)
    step(`tone tab open as "${TAB_TITLE}" — the picker is answered with its title`)
    /**
     * IT IS OPENED IN THE BACKGROUND ON PURPOSE: the APP tab has to stay
     * foreground, because a hidden tab has its timers clamped to 1 Hz and a
     * take in one is a 2 fps take, not a soak (CLAUDE.md's pane rule, and the
     * same physics). The tone tab being hidden is fine — being CAPTURED keeps a
     * tab rendering, and audio is not throttled either way. If a rehearsal ever
     * shows a frozen picture out of this lane, that assumption is where to look
     * first.
     */
  }

  // The idle page, before a take exists — every later sample is read against it.
  report.baseline = {
    ...(await session.evalJson(PAGE_SAMPLE)),
    rss: chromeRss(profile),
  }
  step(`baseline read · rss ${(report.baseline.rss.totalKb / 1024).toFixed(0)} MB`)

  const startWall = await session.evaluate(
    `(() => { const b = ${START_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
  )
  if (!startWall) throw new Error('no record button to press')
  report.startWall = startWall
  step(`record pressed — first sample in ${(opts.sampleMs / 1000).toFixed(0)} s`)

  /** THE WAIT BETWEEN SAMPLES WAKES ON A DEATH. A take that loses its renderer
   *  has nothing left to measure, and sleeping out the rest of the grid only
   *  delays saying so. */
  const sleepWatching = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until && !session.dead) await sleep(Math.min(2000, until - Date.now()))
  }
  const noteDeath = () => {
    report.crashed = { ...session.dead, minute: +(((session.dead.atMs - startWall) / 60_000).toFixed(2)) }
    report.consoleTail = session.consoleLines.slice(-60)
    step(
      `THE TAKE'S TAB DIED at ${report.crashed.minute} min — ${report.crashed.why}. ` +
        `Nothing after this is measurable; the console tail is in the report.`,
    )
  }

  const endAt = startWall + opts.minutes * 60_000
  let n = 0
  while (Date.now() < endAt) {
    await sleepWatching(Math.min(opts.sampleMs, Math.max(0, endAt - Date.now())))
    if (session.dead) {
      noteDeath()
      break
    }
    const page = await session.evalJson(PAGE_SAMPLE).catch((err) => ({ error: String(err) }))
    let metrics = null
    try {
      const r = await session.send('Performance.getMetrics')
      metrics = Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))
    } catch {
      /* the domain refused — RSS still carries the run */
    }
    const fpsLine = [...session.consoleLines].reverse().find((l) => /screen delivering/.test(l)) ?? null
    const sample = {
      minute: +(((Date.now() - startWall) / 60_000).toFixed(2)),
      rss: chromeRss(profile),
      heapUsed: page?.heapUsed ?? null,
      heapTotal: page?.heapTotal ?? null,
      storageUsage: page?.storageUsage ?? null,
      recording: page?.recording ?? false,
      nodes: metrics?.Nodes ?? null,
      documents: metrics?.Documents ?? null,
      listeners: metrics?.JSEventListeners ?? null,
      jsHeapUsed: metrics?.JSHeapUsedSize ?? null,
      fps: fpsLine ? /([\d.]+) fps/.exec(fpsLine)?.[1] ?? null : null,
      error: page?.error ?? null,
    }
    report.samples.push(sample)
    n++
    console.error(
      `memory-slope: ${String(sample.minute).padStart(5)} min · rss ${(sample.rss.totalKb / 1024).toFixed(0)} MB ` +
        `(${sample.rss.processes} proc) · heap ${sample.heapUsed ? (sample.heapUsed / 1048576).toFixed(0) : '—'} MB · ` +
        `disk ${sample.storageUsage ? (sample.storageUsage / 1048576).toFixed(0) : '—'} MB · ` +
        `${sample.fps ?? '—'} fps · recording=${sample.recording}`,
    )
    // A DEAD TAKE MAKES A FLAT CURVE. Stop rather than spend an hour measuring
    // the memory of a page that is no longer recording anything.
    if (!sample.recording) {
      report.diedAtMinute = sample.minute
      break
    }
  }

  report.stoppedItself = !!report.diedAtMinute
  // A crashed tab has no Stop button and no card. Pressing at it would only
  // spend the card's five-minute budget failing.
  if (!report.stoppedItself && !report.crashed) {
    const stopWall = await session.evaluate(
      `(() => { const b = ${STOP_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
    )
    report.stopWall = stopWall ?? null
    step('stop pressed — waiting for the card')
    // The take is written at stop; the card is the product's own verdict on it.
    const cardDeadline = Date.now() + 300_000
    while (Date.now() < cardDeadline && !session.dead) {
      const c = await session
        .evalJson(
          `(async () => { if (typeof __inoutReport !== 'function') return JSON.stringify(null)
            try { const c = await __inoutReport(); return JSON.stringify(c && { verdict: c.verdict, line: c.line ?? null }) }
            catch (e) { return JSON.stringify({ error: String(e) }) } })()`,
        )
        .catch(() => null)
      if (c?.verdict) {
        report.card = c
        break
      }
      await sleep(5000)
    }
    if (session.dead) noteDeath()
    else report.afterStop = { ...(await session.evalJson(PAGE_SAMPLE)), rss: chromeRss(profile) }
  }
  report.consoleTail ??= session.consoleLines.slice(-60)
} catch (err) {
  report.error = String(err)
} finally {
  await quitChrome(session)
  if (!opts.keepProfile) rmSync(profile, { recursive: true, force: true })
}

// ---- the curve ------------------------------------------------------------
const warm = report.samples.filter((s) => s.minute >= BAND.warmupMin && s.recording)
const rssFit = fit(warm.map((s) => ({ x: s.minute, y: s.rss.totalKb / 1024 })))
const heapFit = fit(warm.map((s) => ({ x: s.minute, y: (s.heapUsed ?? 0) / 1048576 })))
const nodeFit = fit(warm.map((s) => ({ x: s.minute, y: s.nodes ?? 0 })))
/**
 * HALF-MEANS, NOT ONLY A SLOPE. RSS on this machine oscillates by ±90 MB while
 * macOS reclaims, and a least-squares line over a short window will happily
 * report several MB/min out of that noise — the first 60-minute cell read
 * +0.03 MB/min over the hour (r2 0.000) and +3.45 MB/min over its second half
 * alone (r2 0.30). Comparing the MEAN of the two halves is the statistic that
 * survives the oscillation: a real leak moves the mean, noise does not.
 */
function halfMeans(rows) {
  if (rows.length < 6) return null
  const mid = rows[0].x + (rows[rows.length - 1].x - rows[0].x) / 2
  const a = rows.filter((r) => r.x < mid)
  const b = rows.filter((r) => r.x >= mid)
  const mean = (xs) => xs.reduce((t, r) => t + r.y, 0) / xs.length
  return { firstHalfMb: +mean(a).toFixed(0), secondHalfMb: +mean(b).toFixed(0), deltaMb: +(mean(b) - mean(a)).toFixed(0) }
}

/** Which process is doing it, if anything is. The aggregate can sit flat while
 *  one process climbs and another is reclaimed underneath it. */
const byType = {}
for (const t of new Set(warm.flatMap((s) => Object.keys(s.rss.byType)))) {
  const rows = warm.map((s) => ({ x: s.minute, y: (s.rss.byType[t] ?? 0) / 1024 }))
  const f = fit(rows)
  byType[t] = {
    mbPerMin: f.slope === null ? null : +f.slope.toFixed(3),
    r2: f.r2 === null ? null : +f.r2.toFixed(3),
    halves: halfMeans(rows),
  }
}

report.slope = {
  warmupMin: BAND.warmupMin,
  samplesAfterWarmup: warm.length,
  byType,
  rssHalves: halfMeans(warm.map((s) => ({ x: s.minute, y: s.rss.totalKb / 1024 }))),
  rssMinMb: warm.length ? +Math.min(...warm.map((s) => s.rss.totalKb / 1024)).toFixed(0) : null,
  rssMaxMb: warm.length ? +Math.max(...warm.map((s) => s.rss.totalKb / 1024)).toFixed(0) : null,
  processCounts: [...new Set(report.samples.map((s) => s.rss.processes))],
  rssMbPerMin: rssFit.slope === null ? null : +rssFit.slope.toFixed(3),
  rssR2: rssFit.r2 === null ? null : +rssFit.r2.toFixed(3),
  heapMbPerMin: heapFit.slope === null ? null : +heapFit.slope.toFixed(3),
  heapR2: heapFit.r2 === null ? null : +heapFit.r2.toFixed(3),
  nodesPerMin: nodeFit.slope === null ? null : +nodeFit.slope.toFixed(2),
  rssHighWaterMb: report.samples.length
    ? +Math.max(...report.samples.map((s) => s.rss.totalKb / 1024)).toFixed(0)
    : null,
  rssFirstMb: warm.length ? +(warm[0].rss.totalKb / 1024).toFixed(0) : null,
  rssLastMb: warm.length ? +(warm[warm.length - 1].rss.totalKb / 1024).toFixed(0) : null,
}
report.gates = {
  takeSurvived: !report.error && !report.stoppedItself && !report.crashed,
  rssSlopeInBand: report.slope.rssMbPerMin !== null && Math.abs(report.slope.rssMbPerMin) < BAND.rssMbPerMin,
  heapSlopeInBand: report.slope.heapMbPerMin !== null && Math.abs(report.slope.heapMbPerMin) < BAND.heapMbPerMin,
}
exitCode = Object.values(report.gates).every(Boolean) ? 0 : 1

// THE CURVE, on the console, because a handoff quotes a shape and not a file.
if (report.samples.length) {
  const vals = report.samples.map((s) => s.rss.totalKb / 1024)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const W = 48
  console.error(`memory-slope: RSS ${lo.toFixed(0)}-${hi.toFixed(0)} MB over ${report.samples.length} samples`)
  for (const s of report.samples) {
    const v = s.rss.totalKb / 1024
    const n = hi === lo ? 1 : Math.max(1, Math.round(((v - lo) / (hi - lo)) * W))
    console.error(`  ${String(Math.round(s.minute)).padStart(3)} min |${'#'.repeat(n).padEnd(W)}| ${v.toFixed(0)} MB`)
  }
}

const outPath = opts.out ?? join(tmpdir(), `memory-slope-${report.startedAt.replace(/[:.]/g, '-')}.json`)
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.error(`memory-slope: report → ${outPath}`)
if (report.crashed) {
  console.error('memory-slope: the last lines the tab said before it died —')
  for (const l of (report.consoleTail ?? []).slice(-12)) console.error(`  | ${l}`)
}
console.log(
  JSON.stringify(
    {
      slope: report.slope,
      card: report.card,
      gates: report.gates,
      crashed: report.crashed ?? null,
      error: report.error ?? null,
    },
    null,
    2,
  ),
)
process.exit(exitCode)
