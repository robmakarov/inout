#!/usr/bin/env node
/**
 * THE TAIL GATE, UNDER LOAD (task P0-tail).
 *
 * O8 shipped a tail band — an export must not be short of its take by more than
 * 400 ms — and it has never once failed, because it has only ever run on the
 * light synthetic rig where the composite loses 70 ms. Under a 4K source the
 * SAME shipped engine was losing 2734 ms and no gate could see it. This runs
 * the band where it can fail.
 *
 * TWO PHASES, because a take has two kinds of file in it (task P0-tail-raw):
 *   composite — the instant path's file, measured through the o4step2 rig;
 *   raw       — what an EDITED take renders from, measured through the REAL
 *               createCaptureSession by the p0tailraw rig.
 * The composite phase can come back INCONCLUSIVE when the watchdog gives up
 * under load (that is the fallback working, not a tail failure) and it has
 * always been reported rather than counted. The raw phase does not depend on
 * the composite surviving, so it is the one that can always answer.
 *
 * HEAVY: it pegs the GPU for the duration. Announce it before running, and
 * never run it while Robert is using the machine (hygiene). It is
 * deliberately NOT in the pre-push hook for that reason.
 *
 * THE SECOND BAND, ADDED 2026-08-26 (task O8b). The tail band answers "did the
 * ending survive"; it says nothing about whether the MIDDLE did. A composite
 * that delivers 8 fps under load has a perfect tail and is still a ruined take,
 * and that is not hypothetical — the 08-22 4K freeze delivered 21.5/11.9 fps
 * against a 30 target and no gate could see it (the cap that fixed it is
 * CAPTURE_MAX_*, and nothing re-checks that the cap is doing its job). Both
 * phases already MEASURED deliveredFps and neither gated it. They do now.
 *
 * THE BAND IS 10, AND IT IS A PRINCIPLE RATHER THAN A FITTED NUMBER: below a
 * third of the 30 fps target the result is not usable footage, whatever else is
 * true. It cannot be tighter yet, and the reason is worth knowing before anyone
 * tightens it — THIS RIG'S 4K SOURCE IS UNCAPPED. Production constrains the
 * display track to 1080p30 (CAPTURE_MAX_* in acquire.ts, the 08-22 freeze fix),
 * but a canvas captureStream does not honour a resolution constraint, so what
 * the rig measures is the regime the cap exists to prevent. Measured healthy
 * here: composite 15 fps, raw channels 14.0-14.2 — against 28-30 on a 1080p
 * lane. O4-polish's remaining "4K row in production shape" is what would let
 * this band move up to something that means "the cap is working".
 * Raising --fpsBand is how the gate is proven red: for a threshold gate, the
 * threshold IS the injection.
 *
 * ONE PAGE PER RUN, AND THAT IS A FIX, NOT A STYLE (task G2, 2026-08-29).
 * The raw phase used to hand all N takes to a single page. Measured at 4K: the
 * FIRST take in a page stops in 0.8-3.9 s and its source hands over 129-177
 * frames; the SECOND take in that same page stops in 39.9-54.2 s and hands over
 * 87-97, with `live composite stop failed` on the console. Two takes run in
 * two FRESH pages, back to back on the same hot machine, both behave like a
 * first take (stop 3845 ms and 773 ms). So it is the page, not the machine, and
 * half of every previous multi-run verdict was measured on a page this rig had
 * already broken. The composite phase always did it this way; the raw phase
 * does now.
 *
 * AND THE SOURCE IS REPORTED, because a band on a synthetic source is only
 * about the product if the source kept up. A run whose source starved is
 * SOURCE-STARVED, not FAIL: it says nothing about the engine either way, and
 * counting it as a product failure is how `oracle:load` spent an unknown number
 * of sessions being red at nobody.
 *
 * Usage: node scripts/oracle-load.mjs [--runs=2] [--takeMs=10000] [--band=400]
 *                                     [--fpsBand=10] [--sourceBand=20] [--headed]
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let runs = 2
let takeMs = 10_000
let band = 400
let fpsBand = 10
// The rate every source in this rig is asked for is 30; two thirds of it is the
// line below which the source is no longer offering what the bands judge.
let sourceBand = 20
let headed = false
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--runs=')) runs = Number(a.slice(7))
  else if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
  else if (a.startsWith('--band=')) band = Number(a.slice(7))
  else if (a.startsWith('--fpsBand=')) fpsBand = Number(a.slice(10))
  else if (a.startsWith('--sourceBand=')) sourceBand = Number(a.slice(13))
  else if (a === '--headed') headed = true
}

function runExp(id, args, marker) {
  return new Promise((resolve, reject) => {
    const argv = [
      join(ROOT, 'scripts/exp.mjs'),
      id,
      JSON.stringify(args),
      '--timeout=900',
      ...(headed ? ['--headed'] : []),
    ]
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.on('error', reject)
    child.on('close', () => {
      const start = out.indexOf(marker)
      if (start < 0) return reject(new Error(`no report in ${id} output`))
      try {
        resolve(JSON.parse(out.slice(start)))
      } catch (err) {
        reject(err)
      }
    })
  })
}

function runOnce() {
  return new Promise((resolve, reject) => {
    const args = [
      join(ROOT, 'scripts/exp.mjs'),
      'o4step2',
      // rawLane on: production runs a raw channel next to the composite, and
      // the gate is about the file the user gets under that real load.
      JSON.stringify({ takeMs, sizes: [[3840, 2160]], engines: ['v1'], rawLane: true }),
      '--timeout=900',
      ...(headed ? ['--headed'] : []),
    ]
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.on('error', reject)
    child.on('close', () => {
      const start = out.indexOf('{\n  "capableOfV2"')
      if (start < 0) return reject(new Error('no report in experiment output'))
      try {
        resolve(JSON.parse(out.slice(start)))
      } catch (err) {
        reject(err)
      }
    })
  })
}

const results = []
for (let i = 0; i < runs; i++) {
  const report = await runOnce()
  const run = report.runs[0]
  const stats = run?.v1Stats ?? null
  // sourceFrames has been on EngineRun the whole time and this runner never
  // read it. It is the difference between "the engine lost frames" and "there
  // were no frames to lose".
  const sourceFps =
    typeof run?.sourceFrames === 'number' && takeMs > 0
      ? Math.round((run.sourceFrames / (takeMs / 1000)) * 10) / 10
      : null
  results.push({
    tailGapMs: run?.tailGapMs ?? null,
    deliveredFps: run?.deliveredFps ?? null,
    sourceFps,
    sourceStarved: sourceFps === null ? null : sourceFps < sourceBand,
    drainMs: stats?.drainMs ?? null,
    drainedBytes: stats?.drainedBytes ?? null,
    drainTimedOut: stats?.drainTimedOut ?? null,
    rawTailGapMs: run?.rawChannel?.tailGapMs ?? null,
    error: run?.error ?? null,
  })
  console.error(
    `[${i + 1}/${runs}] source=${sourceFps}fps tail=${results[i].tailGapMs}ms fps=${results[i].deliveredFps} ` +
      `drain=${results[i].drainMs}ms(+${results[i].drainedBytes}B) raw=${results[i].rawTailGapMs}ms` +
      (results[i].error ? ` ERROR ${results[i].error}` : ''),
  )
}

/**
 * THE SOURCE GATE, AND IT COMES FIRST (task G2).
 *
 * Everything below judges an ENGINE by counting frames in a file. That is only
 * a statement about the engine if the source offered the frames in the first
 * place — and this rig's 4K source, on this machine, sometimes does not. A run
 * whose source starved is excluded from the tail and fps verdicts with its own
 * name, because scoring it either way is a lie: green would be vacuous and red
 * would be blaming the product for the harness.
 */
function sourceVerdict(rows) {
  const known = rows.filter((r) => typeof r.sourceFps === 'number')
  const starved = known.filter((r) => r.sourceStarved)
  if (known.length === 0) return { verdict: 'UNKNOWN', known: 0, starved: 0 }
  return {
    verdict: starved.length === 0 ? 'ALIVE' : starved.length === known.length ? 'STARVED' : 'MIXED',
    known: known.length,
    starved: starved.length,
  }
}
/** Only runs whose source kept up may vote on a band. */
const sourced = (rows) => rows.filter((r) => r.sourceStarved !== true)

// A run whose composite never materialised (the watchdog gave up under load) is
// not a tail failure — it is the fallback working, and the export renders from
// the raw channels instead. It cannot PROVE the band either, so it is reported
// and excluded rather than silently counted.
const measured = sourced(results).filter((r) => r.tailGapMs !== null)
const failed = measured.filter((r) => r.tailGapMs > band)
const verdict = measured.length > 0 && failed.length === 0 ? 'PASS' : measured.length === 0 ? 'INCONCLUSIVE' : 'FAIL'

// O8b — THE MIDDLE OF THE TAKE, not just its end. A lane that delivered no fps
// number at all is excluded for the same reason a missing tail is: it cannot
// prove the band either way, and counting it as a pass would be the vacuous
// gate note 17 is about.
const fpsMeasured = sourced(results).filter((r) => typeof r.deliveredFps === 'number')
const fpsFailed = fpsMeasured.filter((r) => r.deliveredFps < fpsBand)
const fpsVerdict =
  fpsMeasured.length > 0 && fpsFailed.length === 0
    ? 'PASS'
    : fpsMeasured.length === 0
      ? 'INCONCLUSIVE'
      : 'FAIL'

// PHASE 2 — the RAW channels, through the production stop path (P0-tail-raw).
// An edited take renders from these, so their ending is the ending of every
// take the instant path cannot serve.
const rawRuns = []
for (let i = 0; i < runs; i++) {
  // ONE take per page — see the header. All N in one page halved the source's
  // rate and took 40-54 s to stop.
  const rawReport = await runExp(
    'p0tailraw',
    { takeMs, size: [3840, 2160], procedures: ['production'] },
    '{\n  "takeMs"',
  )
  const r = rawReport.runs?.[0]
  rawRuns.push({
    tailGapMs: r?.tailGapMs ?? null,
    overrunMs: r?.overrunMs ?? null,
    deliveredFps: r?.deliveredFps ?? null,
    sourceFps: r?.sourceFps ?? null,
    sourceStarved: r?.sourceStarved ?? null,
    sourcePaints: r?.sourcePaints?.screen ?? null,
    stopMs: r?.procedureMs ?? null,
    error: r?.error ?? null,
  })
  const last = rawRuns[rawRuns.length - 1]
  console.error(
    `[raw ${i + 1}/${runs}] source=${last.sourceFps}fps` +
      (last.sourcePaints
        ? `(${last.sourcePaints.paints} paints, ${last.sourcePaints.watchdogPaints} watchdog)`
        : '') +
      ` tail=${last.tailGapMs}ms overrun=${last.overrunMs}ms ` +
      `fps=${last.deliveredFps} stop=${last.stopMs}ms` + (last.error ? ` ERROR ${last.error}` : ''),
  )
}
const rawMeasured = sourced(rawRuns).filter((r) => r.tailGapMs !== null)
const rawFailed = rawMeasured.filter((r) => r.tailGapMs > band)
const rawVerdict =
  rawMeasured.length > 0 && rawFailed.length === 0 ? 'PASS' : rawMeasured.length === 0 ? 'INCONCLUSIVE' : 'FAIL'

const rawFpsMeasured = sourced(rawRuns).filter((r) => typeof r.deliveredFps === 'number')
const rawFpsFailed = rawFpsMeasured.filter((r) => r.deliveredFps < fpsBand)
const rawFpsVerdict =
  rawFpsMeasured.length > 0 && rawFpsFailed.length === 0
    ? 'PASS'
    : rawFpsMeasured.length === 0
      ? 'INCONCLUSIVE'
      : 'FAIL'

const compositeSource = sourceVerdict(results)
const rawSource = sourceVerdict(rawRuns)
// A phase every one of whose runs starved measured NOTHING about the product.
// Saying PASS there is the vacuous gate note 17 is about; saying FAIL is worse.
const sourceOk = compositeSource.verdict !== 'STARVED' && rawSource.verdict !== 'STARVED'
if (!sourceOk) {
  console.error(
    `oracle-load: SOURCE STARVED — composite ${compositeSource.starved}/${compositeSource.known} runs, ` +
      `raw ${rawSource.starved}/${rawSource.known} runs below ${sourceBand} fps. ` +
      'The bands below describe this machine, not the engine.',
  )
}

console.log(
  JSON.stringify(
    {
      gate: 'tail-and-fps-under-load',
      band,
      fpsBand,
      sourceBand,
      headed,
      takeMs,
      runs,
      composite: {
        results,
        measured: measured.length,
        verdict,
        source: compositeSource,
        fps: { measured: fpsMeasured.length, failed: fpsFailed.length, verdict: fpsVerdict },
      },
      raw: {
        results: rawRuns,
        measured: rawMeasured.length,
        verdict: rawVerdict,
        source: rawSource,
        fps: { measured: rawFpsMeasured.length, failed: rawFpsFailed.length, verdict: rawFpsVerdict },
      },
      verdict: !sourceOk
        ? `SOURCE-STARVED — composite source ${compositeSource.verdict}, raw source ${rawSource.verdict}: ` +
          'this run says nothing about the engine'
        : verdict === 'PASS' && rawVerdict === 'PASS' && fpsVerdict !== 'FAIL' && rawFpsVerdict !== 'FAIL'
          ? 'PASS'
          : `composite tail ${verdict}/fps ${fpsVerdict} · raw tail ${rawVerdict}/fps ${rawFpsVerdict}`,
    },
    null,
    2,
  ),
)
// A starved source exits NON-ZERO — loudly, and under its own name. It is not a
// pass (nothing was measured) and the runner must not be able to be read as one.
process.exitCode =
  sourceOk &&
  verdict === 'PASS' &&
  rawVerdict === 'PASS' &&
  fpsVerdict !== 'FAIL' &&
  rawFpsVerdict !== 'FAIL'
    ? 0
    : 1
