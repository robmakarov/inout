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
 * never run it while the PO is using the machine (TD hygiene). It is
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
 * Usage: node scripts/oracle-load.mjs [--runs=2] [--takeMs=10000] [--band=400]
 *                                     [--fpsBand=10]
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let runs = 2
let takeMs = 10_000
let band = 400
let fpsBand = 10
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--runs=')) runs = Number(a.slice(7))
  else if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
  else if (a.startsWith('--band=')) band = Number(a.slice(7))
  else if (a.startsWith('--fpsBand=')) fpsBand = Number(a.slice(10))
}

function runExp(id, args, marker) {
  return new Promise((resolve, reject) => {
    const argv = [
      join(ROOT, 'scripts/exp.mjs'),
      id,
      JSON.stringify(args),
      '--timeout=900',
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
  results.push({
    tailGapMs: run?.tailGapMs ?? null,
    deliveredFps: run?.deliveredFps ?? null,
    drainMs: stats?.drainMs ?? null,
    drainedBytes: stats?.drainedBytes ?? null,
    drainTimedOut: stats?.drainTimedOut ?? null,
    rawTailGapMs: run?.rawChannel?.tailGapMs ?? null,
    error: run?.error ?? null,
  })
  console.error(
    `[${i + 1}/${runs}] tail=${results[i].tailGapMs}ms fps=${results[i].deliveredFps} ` +
      `drain=${results[i].drainMs}ms(+${results[i].drainedBytes}B) raw=${results[i].rawTailGapMs}ms` +
      (results[i].error ? ` ERROR ${results[i].error}` : ''),
  )
}

// A run whose composite never materialised (the watchdog gave up under load) is
// not a tail failure — it is the fallback working, and the export renders from
// the raw channels instead. It cannot PROVE the band either, so it is reported
// and excluded rather than silently counted.
const measured = results.filter((r) => r.tailGapMs !== null)
const failed = measured.filter((r) => r.tailGapMs > band)
const verdict = measured.length > 0 && failed.length === 0 ? 'PASS' : measured.length === 0 ? 'INCONCLUSIVE' : 'FAIL'

// O8b — THE MIDDLE OF THE TAKE, not just its end. A lane that delivered no fps
// number at all is excluded for the same reason a missing tail is: it cannot
// prove the band either way, and counting it as a pass would be the vacuous
// gate note 17 is about.
const fpsMeasured = results.filter((r) => typeof r.deliveredFps === 'number')
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
const rawReport = await runExp(
  'p0tailraw',
  { takeMs, size: [3840, 2160], procedures: Array.from({ length: runs }, () => 'production') },
  '{\n  "takeMs"',
)
const rawRuns = (rawReport.runs ?? []).map((r) => ({
  tailGapMs: r.tailGapMs,
  overrunMs: r.overrunMs,
  deliveredFps: r.deliveredFps,
  stopMs: r.procedureMs,
  error: r.error ?? null,
}))
for (const [i, r] of rawRuns.entries()) {
  console.error(
    `[raw ${i + 1}/${rawRuns.length}] tail=${r.tailGapMs}ms overrun=${r.overrunMs}ms ` +
      `fps=${r.deliveredFps} stop=${r.stopMs}ms` + (r.error ? ` ERROR ${r.error}` : ''),
  )
}
const rawMeasured = rawRuns.filter((r) => r.tailGapMs !== null)
const rawFailed = rawMeasured.filter((r) => r.tailGapMs > band)
const rawVerdict =
  rawMeasured.length > 0 && rawFailed.length === 0 ? 'PASS' : rawMeasured.length === 0 ? 'INCONCLUSIVE' : 'FAIL'

const rawFpsMeasured = rawRuns.filter((r) => typeof r.deliveredFps === 'number')
const rawFpsFailed = rawFpsMeasured.filter((r) => r.deliveredFps < fpsBand)
const rawFpsVerdict =
  rawFpsMeasured.length > 0 && rawFpsFailed.length === 0
    ? 'PASS'
    : rawFpsMeasured.length === 0
      ? 'INCONCLUSIVE'
      : 'FAIL'

console.log(
  JSON.stringify(
    {
      gate: 'tail-and-fps-under-load',
      band,
      fpsBand,
      takeMs,
      runs,
      composite: {
        results,
        measured: measured.length,
        verdict,
        fps: { measured: fpsMeasured.length, failed: fpsFailed.length, verdict: fpsVerdict },
      },
      raw: {
        results: rawRuns,
        measured: rawMeasured.length,
        verdict: rawVerdict,
        fps: { measured: rawFpsMeasured.length, failed: rawFpsFailed.length, verdict: rawFpsVerdict },
      },
      verdict:
        verdict === 'PASS' && rawVerdict === 'PASS' && fpsVerdict !== 'FAIL' && rawFpsVerdict !== 'FAIL'
          ? 'PASS'
          : `composite tail ${verdict}/fps ${fpsVerdict} · raw tail ${rawVerdict}/fps ${rawFpsVerdict}`,
    },
    null,
    2,
  ),
)
process.exitCode =
  verdict === 'PASS' && rawVerdict === 'PASS' && fpsVerdict !== 'FAIL' && rawFpsVerdict !== 'FAIL'
    ? 0
    : 1
