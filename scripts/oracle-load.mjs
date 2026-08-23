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
 * HEAVY: it pegs the GPU for the duration. Announce it before running, and
 * never run it while the PO is using the machine (TD hygiene). It is
 * deliberately NOT in the pre-push hook for that reason.
 *
 * Usage: node scripts/oracle-load.mjs [--runs=2] [--takeMs=10000] [--band=400]
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let runs = 2
let takeMs = 10_000
let band = 400
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--runs=')) runs = Number(a.slice(7))
  else if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
  else if (a.startsWith('--band=')) band = Number(a.slice(7))
}

function runOnce() {
  return new Promise((resolve, reject) => {
    const args = [
      join(ROOT, 'scripts/exp.mjs'),
      'o4step2',
      JSON.stringify({ takeMs, sizes: [[3840, 2160]], engines: ['v1'] }),
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
console.log(
  JSON.stringify({ gate: 'tail-under-load', band, takeMs, runs, results, measured: measured.length, verdict }, null, 2),
)
process.exitCode = verdict === 'PASS' ? 0 : 1
