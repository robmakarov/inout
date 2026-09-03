#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless pipeline oracle driver (task oracle-ci).
 *
 * Always spawns an ephemeral Vite server on a free port (never reuses a shared
 * dev server — 2026-07-16: pointing at :5173 poisoned Robert's QA). Runs synthetic
 * capture→export→measure via CDP, evaluates CI gates, exits nonzero on failure.
 *
 * THE LENGTH IS PART OF THE MEASUREMENT (task G4, 2026-08-29). This defaults to a
 * 6 s take and the widest cell in any matrix here is 30 s; Robert records
 * 938-1800 s. That is not a detail — the instant path was measured at 117.2 /
 * 153.8 ms at 120 s while reading 97-102 ms at 6 s on the SAME defect, so the
 * short gate under-reported it by ~20 % and passed it. `--recordMs=` makes the
 * long cell one command (`npm run oracle:long` = 120 s), and the operating
 * rules in `.ai/TASKS` require it before any flip that touches the instant or
 * smart-cut paths.
 *
 * Usage:
 *   npm run oracle              # single cold run, 6 s take
 *   npm run oracle:long         # ONE 120 s take through both packet-copy paths (HEAVY, announce it)
 *   npm run oracle:cold         # 20 consecutive cold runs (fresh Chrome profile each)
 *   node scripts/oracle.mjs --headed --recordMs=180000 --trimMs=4271
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gateOracleReport, oracleMetricsIncomplete } from './oracle-gate.mjs'
import {
  disagreement,
  dimensionsOf,
  loadLine,
  startLoadSampler,
  waitForQuiet,
} from './lib/machine.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Reserved for interactive `npm run dev` / Robert's QA — oracle must never use it. */
const FORBIDDEN_PORTS = new Set([5173])

function parseArgs(argv) {
  let cold = 1
  let headed = false
  let engine = ''
  // O5-flip A/B lever: --no-composite restores the pre-O5-flip rig (channels
  // only, no live composite alongside). The oracle records one by default now
  // because every real take has one; this is how that change is checked
  // against the sync band rather than assumed harmless.
  let composite = true
  // G4: the take length, and the trim offset applied to it. The trim must stay
  // OFF the composite's 2 s keyframe grid or the smart-cut path is never
  // exercised — 1483 ms is the shipped default for exactly that reason, and a
  // longer cell needs a value with the same property (see --recordMs below).
  let recordMs = 6000
  let trimMs = 0
  /**
   * WHERE THE WHOLE REPORT GOES (task G5, 2026-09-01). A passing run used to
   * throw its report away — only a FAILING one was dumped — so any question
   * about the numbers BEHIND a green verdict (here: the rig's own reference
   * schedules, which is what the correction is built from) cost a fresh matrix.
   * `--dumpDir=` keeps every run, pass or fail.
   */
  let dumpDir = ''
  for (const a of argv) {
    if (a === '--no-composite') { composite = false; continue }
    if (a.startsWith('--cold=')) cold = Number(a.slice(7))
    else if (a === '--headed') headed = true
    else if (a.startsWith('--recordMs=')) recordMs = Number(a.slice(11))
    else if (a.startsWith('--trimMs=')) trimMs = Number(a.slice(9))
    else if (a.startsWith('--engine=')) engine = a.slice(9)
    else if (a.startsWith('--dumpDir=')) dumpDir = a.slice(10)
    else if (a.startsWith('--port=')) {
      console.error(
        "oracle: --port is disabled (ephemeral server only; never share with Robert's QA)",
      )
      process.exit(2)
    }
  }
  if (!Number.isFinite(recordMs) || recordMs < 1000) {
    console.error(`oracle: --recordMs=${recordMs} is not a take length`)
    process.exit(2)
  }
  // A trim must land off the 2 s keyframe grid AND leave material on both
  // sides. Scaled from the take rather than fixed, so a 120 s cell trims a
  // meaningful amount instead of 1.2 % of itself, and the 483 ms tail keeps it
  // off the grid at every length.
  if (!trimMs) trimMs = recordMs <= 10_000 ? 1483 : Math.round(recordMs / 4 / 2000) * 2000 + 483
  if (trimMs % 2000 === 0) {
    console.error(`oracle: --trimMs=${trimMs} sits ON the 2 s keyframe grid — smart cut would not be exercised`)
    process.exit(2)
  }
  return { cold, headed, engine, composite, recordMs, trimMs, dumpDir }
}


/**
 * THE DISTRIBUTION BEHIND A GATE NUMBER (task G1, 2026-09-01).
 *
 * `syncMaxAbs` is an EXTREME over the take's pairs and the band it is checked
 * against is a constant, so two very different files read the same: a tight
 * scatter sampled many times, and a genuine ramp. This reduces the per-pair
 * offsets the analysis now carries to the numbers that separate them — spread
 * (sd), the worst deviation from the mean, and the least-squares drift of
 * offset against take time with its R². A ramp is slope-dominated with R² near
 * 1; sampling noise is not.
 */
function dist(fs) {
  if (!fs || !Array.isArray(fs.offsetsMs) || fs.offsetsMs.length === 0) return null
  const d = fs.offsetsMs
  const t = Array.isArray(fs.pairSec) && fs.pairSec.length === d.length ? fs.pairSec : null
  const n = d.length
  const mean = d.reduce((s, x) => s + x, 0) / n
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0
  const maxDev = Math.max(...d.map((x) => Math.abs(x - mean)))
  let slopeMsPerSec = null
  let r2 = null
  if (t && n > 2) {
    const tm = t.reduce((s, x) => s + x, 0) / n
    const sxx = t.reduce((s, x) => s + (x - tm) ** 2, 0)
    const sxy = t.reduce((s, x, i) => s + (x - tm) * (d[i] - mean), 0)
    if (sxx > 0) {
      slopeMsPerSec = sxy / sxx
      const ssTot = d.reduce((s, x) => s + (x - mean) ** 2, 0)
      const ssRes = d.reduce((s, x, i) => s + (x - (mean + slopeMsPerSec * (t[i] - tm))) ** 2, 0)
      r2 = ssTot > 0 ? 1 - ssRes / ssTot : null
    }
  }
  return {
    n,
    meanMs: Math.round(mean * 100) / 100,
    sdMs: Math.round(sd * 100) / 100,
    maxDevMs: Math.round(maxDev * 100) / 100,
    minMs: Math.min(...d),
    maxMs: Math.max(...d),
    slopeMsPerSec: slopeMsPerSec === null ? null : Math.round(slopeMsPerSec * 1000) / 1000,
    r2: r2 === null ? null : Math.round(r2 * 1000) / 1000,
    spanSec: t ? Math.round((t[t.length - 1] - t[0]) * 100) / 100 : null,
    offsetsMs: d,
    pairSec: t,
  }
}

/** The three lanes' distributions from one report. */
function reportDists(report) {
  return {
    render: dist(report?.full?.flashSyncUnbiased ?? report?.full?.flashSync),
    instant: dist(report?.instantFlashSync),
    trimmed: dist(report?.trimmed?.flashSyncUnbiased ?? report?.trimmed?.flashSync),
  }
}

function fmtDist(label, d) {
  if (!d) return `${label}=n/a`
  return (
    `${label}[n=${d.n} sd=${d.sdMs.toFixed(1)} dev=${d.maxDevMs.toFixed(1)}` +
    (d.slopeMsPerSec === null
      ? ''
      : ` drift=${d.slopeMsPerSec >= 0 ? '+' : ''}${d.slopeMsPerSec.toFixed(3)}ms/s r2=${
          d.r2 === null ? 'n/a' : d.r2.toFixed(2)
        }`) +
    ']'
  )
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Bind port 0 to let the OS assign a free port, then release it for Vite. */
function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, HOST, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => {
        if (err) reject(err)
        else if (!port || FORBIDDEN_PORTS.has(port)) reject(new Error(`bad ephemeral port ${port}`))
        else resolve(port)
      })
    })
    s.on('error', reject)
  })
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${url}`)
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: opts.quiet ? 'pipe' : 'inherit', cwd: ROOT, ...opts })
    let out = ''
    let err = ''
    if (opts.quiet) {
      child.stdout?.on('data', (d) => {
        out += String(d)
      })
      child.stderr?.on('data', (d) => {
        err += String(d)
      })
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err, ok: true })
      else resolve({ out, err, ok: false, code })
    })
  })
}

async function runOracleOnce(port, headed, engine, composite = true, recordMs = 6000, trimMs = 1483, logDir = '') {
  const cdpArgs = [
    join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
    'oracle',
    JSON.stringify({ composite, recordMs, trimMs }),
    `--port=${port}`,
  ]
  /**
   * THE 120 s CELL DIED ~1/3 OF THE TIME AND NOTHING SAID WHY (task G6d).
   * cdp-run keeps Chrome's own stderr and the page's console for exactly this,
   * behind `--logDir=`, and this runner never passed it — so every death
   * reached the console as `cdp-run exited 1` with the diagnosis already
   * written and thrown away. It costs two files per attempt.
   */
  if (logDir) cdpArgs.push(`--logDir=${logDir}`)
  if (headed) cdpArgs.push('--headed')
  // Which live-composite engine made the file under test (O4 step 2). An
  // unedited take IS the composite, so this is the one knob that changes what
  // the sync and tail bands are actually measuring.
  if (engine) cdpArgs.push(`--query=engine=${engine}`)
  const result = await run(process.execPath, cdpArgs, { quiet: true })
  if (!result.ok) {
    return {
      error: result.err.trim() || `cdp-run exited ${result.code}`,
      report: null,
    }
  }
  try {
    return { error: null, report: JSON.parse(result.out.trim()) }
  } catch (e) {
    // THE LENGTH IS THE DIAGNOSIS (task G4). A report cut at a power of two is
    // a broken pipe, not a broken experiment — cdp-run used to `process.exit()`
    // before stdout drained, so anything past macOS's 64 KiB pipe buffer was
    // discarded and every long cell died here looking like a flake.
    const n = result.out.length
    const suspectTruncation = n > 0 && (n & (n - 1)) === 0
    return {
      error:
        `invalid JSON after ${n} bytes: ${String(e)}` +
        (suspectTruncation ? ' — that is exactly a pipe-buffer boundary: the report was TRUNCATED, not malformed' : ''),
      report: null,
    }
  }
}

const METRIC_RETRY_COOLDOWN_MS = 5000
/**
 * THREE, NOT TWO (task G6d). The 120 s cell dies on CDP about one run in three
 * — a launch that never exposes a debug target, a renderer that goes away, a
 * report that never arrives. Two attempts leave a 1-in-9 chance of losing a
 * cell that costs five minutes; three make it 1-in-27, and the attempts are
 * only paid when something already went wrong.
 */
const METRIC_RETRY_MAX = 3

/** One attempt, with the load it ran under measured alongside it. */
async function attemptOracle(opts, logDir) {
  const sampler = startLoadSampler()
  const t0 = Date.now()
  const { error, report } = await runOracleOnce(
    opts.port,
    opts.headed,
    opts.engine,
    opts.composite,
    opts.recordMs,
    opts.trimMs,
    logDir,
  )
  const elapsedMs = Date.now() - t0
  const load = sampler.stop()
  const gate = report ? gateOracleReport(report) : null
  return { error: error ?? null, report, gate, elapsedMs, load }
}

/**
 * ONE READING IS NOT A VERDICT ON THIS MACHINE (task G6a-d).
 *
 * Three things happen here, and they are three different problems.
 *
 *  1. A CDP DEATH IS AN INSTRUMENT FAILURE, and it is retried — with the
 *     chrome stderr and page console kept, which is new (G6d): the death used
 *     to arrive as `cdp-run exited 1` with its own diagnosis discarded.
 *
 *  2. NULL METRICS ARE RETRIED, as before.
 *
 *  3. A RED IS CONFIRMED BEFORE IT IS BELIEVED. This is the fix for the coin
 *     flips (a) export throughput, (c) spur: both are timing/level numbers that
 *     move with what else is on the machine, and both used to decide a merge on
 *     one reading. A second reading is taken and the two are compared BY
 *     DIMENSION, not by value:
 *       · red in both  -> FAIL, and the gate now says it twice with both numbers;
 *       · red in one   -> INCONCLUSIVE. Not green, not a regression, exit
 *                        nonzero, and the word says exactly what it is: this
 *                        run says nothing about the engine.
 *     A structural failure (a declined path, a lost tail) reproduces, so it
 *     costs one extra cell and is never mislabelled. That is the trade, and it
 *     is worth it: the expensive failure is not a slow gate, it is a session
 *     "fixing" a bug that was another session's render.
 */
async function runOracleOnceGated(opts, confirm) {
  let last = { error: 'no attempt', report: null, gate: null }
  for (let attempt = 1; attempt <= METRIC_RETRY_MAX; attempt++) {
    const logDir = join(tmpdir(), `oracle-cdp-${Date.now()}-${attempt}`)
    const a = await attemptOracle(opts, logDir)
    if (a.error || !a.report || !a.gate) {
      last = { ...a, error: a.error ?? 'no report', attempt, cdpLogDir: logDir }
      if (attempt < METRIC_RETRY_MAX) {
        console.error(
          `[oracle] attempt ${attempt}/${METRIC_RETRY_MAX} INSTRUMENT error: ${last.error} — ` +
            `${loadLine(a.load)} · logs ${logDir} — retry in ${METRIC_RETRY_COOLDOWN_MS}ms`,
        )
        await sleep(METRIC_RETRY_COOLDOWN_MS)
        continue
      }
      console.error(
        `[oracle] FAIL LOUD: cdp-run died on all ${METRIC_RETRY_MAX} attempts — that is the ` +
          `INSTRUMENT, not the engine. Chrome stderr and page console: ${logDir}`,
      )
      return last
    }
    if (oracleMetricsIncomplete(a.gate.metrics)) {
      const why = a.gate.failures.join('; ')
      last = { ...a, error: `incomplete metrics: ${why}`, attempt, cdpLogDir: logDir }
      if (attempt < METRIC_RETRY_MAX) {
        console.error(
          `[oracle] attempt ${attempt}/${METRIC_RETRY_MAX} all-null/incomplete metrics ` +
            `(${loadLine(a.load)}) — retry in ${METRIC_RETRY_COOLDOWN_MS}ms`,
        )
        await sleep(METRIC_RETRY_COOLDOWN_MS)
        continue
      }
      console.error(`[oracle] FAIL LOUD: incomplete metrics after ${METRIC_RETRY_MAX} attempts — ${why}`)
      return last
    }
    const first = { error: null, report: a.report, gate: a.gate, elapsedMs: a.elapsedMs, load: a.load, attempt }
    if (a.gate.pass || !confirm) return first
    // ---- the red needs a second reading before anyone acts on it ----
    console.error(
      `[oracle] RED on one reading (${a.gate.failures.map((f) => f.split(' (')[0]).join('; ')}) ` +
        `under ${loadLine(a.load)} — confirming with a second cell before calling it a regression`,
    )
    const bLog = join(tmpdir(), `oracle-cdp-${Date.now()}-confirm`)
    const b = await attemptOracle(opts, bLog)
    if (b.error || !b.report || !b.gate || oracleMetricsIncomplete(b.gate.metrics)) {
      console.error(
        `[oracle] the confirming cell could not be measured (${b.error ?? 'incomplete metrics'}) — ` +
          'INCONCLUSIVE: the first reading stands unconfirmed and this run says nothing about the engine',
      )
      return { ...first, inconclusive: true, confirm: { error: b.error ?? 'incomplete metrics', load: b.load } }
    }
    const cmp = disagreement(a.gate.failures, b.gate.failures)
    if (cmp.disagreed.length === 0) {
      console.error(
        `[oracle] CONFIRMED on a second cell — ${cmp.agreed.join(', ')} red in both readings ` +
          `(${loadLine(a.load)} / ${loadLine(b.load)}). This is a finding.`,
      )
      return { ...first, confirmedBy: { failures: b.gate.failures, metrics: b.gate.metrics, load: b.load } }
    }
    console.error(
      `[oracle] INCONCLUSIVE — the two readings disagree on: ${cmp.disagreed.join(', ')}` +
        (cmp.agreed.length ? ` (both red on: ${cmp.agreed.join(', ')})` : '') +
        `. Reading 1 ${loadLine(a.load)}: ${a.gate.failures.join('; ') || 'green'}` +
        `. Reading 2 ${loadLine(b.load)}: ${b.gate.failures.join('; ') || 'green'}` +
        '. THIS RUN SAYS NOTHING ABOUT THE ENGINE — re-run on a quiet machine.',
    )
    return {
      ...first,
      inconclusive: true,
      confirm: { failures: b.gate.failures, metrics: b.gate.metrics, load: b.load },
      disagreed: cmp.disagreed,
      agreed: cmp.agreed,
    }
  }
  return last
}

async function main() {
  const { cold, headed, engine, composite, recordMs, trimMs, dumpDir } = parseArgs(process.argv.slice(2))
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true })
    console.error(`oracle: every run's full report → ${dumpDir}/run-N.json`)
  }
  // G4: the length is part of the verdict, so it is on the console before the
  // first number and in the JSON beside them. A session reading an old report
  // must never have to guess which cell it was.
  if (recordMs !== 6000) {
    console.error(
      `oracle: LONG CELL — ${(recordMs / 1000).toFixed(0)} s take, trim at ${trimMs} ms ` +
        `(off the 2 s keyframe grid). Budget roughly ${Math.ceil((recordMs * 2.2 + 25_000) / 1000)} s per run.`,
    )
  }

  try {
    await run(CHROME, ['--version'], { stdio: 'pipe' })
  } catch {
    console.error('Chrome not found — set CHROME_BIN or install Google Chrome')
    process.exit(2)
  }

  const port = await allocateEphemeralPort()
  console.error(`oracle: ephemeral server on http://${HOST}:${port} (isolated from Robert's QA)`)

  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  let viteErr = ''
  vite.stderr?.on('data', (d) => {
    viteErr += String(d)
  })

  const results = []
  try {
    await waitForHttp(`http://${HOST}:${port}/experimental.html`, Date.now() + 60_000)

    const dumpRun = (i, payload) => {
      if (!dumpDir) return
      try {
        writeFileSync(join(dumpDir, `run-${i + 1}.json`), JSON.stringify(payload))
      } catch (err) {
        console.error(`  (could not dump run ${i + 1}: ${err?.message ?? err})`)
      }
    }

    /**
     * WHAT THE MACHINE WAS DOING BEFORE WE ADDED TO IT (task G6a-d). Measured
     * once, before the first cell, while nothing of ours is running yet — the
     * only moment at which "busy" means somebody ELSE. Bounded and loud: on a
     * machine that never goes quiet the cell still runs, and the load it ran
     * under is printed beside every number it produces.
     */
    const preflight = await waitForQuiet({ label: 'oracle', maxWaitMs: 60_000 })

    for (let i = 0; i < cold; i++) {
      const run = await runOracleOnceGated(
        { port, headed, engine, composite, recordMs, trimMs },
        // A single cell decides a merge, so it confirms its own red. A cold
        // MATRIX is already repetition — its disagreements are counted across
        // the runs below instead, at no extra cost.
        cold === 1,
      )
      const elapsed = run.elapsedMs ?? 0
      dumpRun(i, {
        run: i + 1,
        recordMs,
        trimMs,
        engine: engine || 'default',
        elapsedMs: elapsed,
        error: run.error ?? null,
        load: run.load ?? null,
        inconclusive: run.inconclusive ?? false,
        confirm: run.confirm ?? run.confirmedBy ?? null,
        gate: run.gate ?? null,
        report: run.report ?? null,
      })
      if (run.error || !run.report || !run.gate) {
        results.push({
          run: i + 1,
          elapsedMs: elapsed,
          error: run.error,
          load: run.load ?? null,
          cdpLogDir: run.cdpLogDir ?? null,
          gate: run.gate ?? { pass: false, failures: [run.error ?? 'no report'], metrics: {} },
        })
        console.error(
          `[${i + 1}/${cold}] ERROR ${run.error ?? 'no report'} (${elapsed}ms, ${loadLine(run.load)})` +
            (run.cdpLogDir ? ` · chrome stderr + page console: ${run.cdpLogDir}` : ''),
        )
        continue
      }
      const gate = run.gate
      results.push({
        run: i + 1,
        elapsedMs: elapsed,
        gate,
        report: run.report,
        load: run.load ?? null,
        inconclusive: run.inconclusive ?? false,
        disagreed: run.disagreed ?? null,
      })
      const m = gate.metrics
      const sync = m.syncMeanMs?.toFixed?.(1) ?? 'n/a'
      const max = m.syncMaxAbsMs?.toFixed?.(1) ?? 'n/a'
      const spur = m.spurPeakDb?.toFixed?.(1) ?? 'n/a'
      const status = gate.pass ? 'PASS' : run.inconclusive ? 'INCONCLUSIVE' : 'FAIL'
      const tail = m.tailDurationDeltaMs ?? 'n/a'
      const rt = m.exportRealtimeFactor ?? 'n/a'
      console.error(
        `[${i + 1}/${cold}] ${status} sync=${sync}/${max}ms spur=${spur}dB jump=${m.maxBoundaryJump ?? 'n/a'} ` +
          `compT0=${
            typeof m.compositeFirstPacketSec === 'number' ? `${(m.compositeFirstPacketSec * 1000).toFixed(0)}ms` : 'n/a'
          } ` +
          `compOff=${typeof m.compositeStartOffsetMs === 'number' ? `${m.compositeStartOffsetMs}ms` : 'n/a'} ` +
          `inst=${m.instantPath ?? 'n/a'}/${
            typeof m.instantSyncMeanMs === 'number' ? `${m.instantSyncMeanMs.toFixed(1)}ms` : 'n/a'
          } ` +
          `trim=${m.trimmedPath ?? 'n/a'}/${
            typeof m.trimmedSyncMeanMs === 'number' ? `${m.trimmedSyncMeanMs.toFixed(1)}ms` : 'n/a'
          } ` +
          `tail=${tail}ms export=${rt}x peakOut=${
            typeof m.exportPeakOutputBytes === 'number'
              ? `${(m.exportPeakOutputBytes / 1024 / 1024).toFixed(1)}MB`
              : 'n/a'
          } aliased=${m.aliased ?? false} ` +
          // GATE-alias: WHICH metric the band was applied to, and the two
          // reference skews behind it. A cold flake was argued about for an
          // hour because the line said 'sync=-465' and not that the number was
          // the RAW rung with both corrections already refused.
          `metric=${m.syncMetric ?? 'n/a'} skew=${
            typeof run.report?.rigDebug?.audioSkewMeanMs === 'number'
              ? run.report.rigDebug.audioSkewMeanMs.toFixed(0)
              : 'n/a'
          }/${
            typeof run.report?.rigDebug?.flashSkewMeanMs === 'number'
              ? run.report.rigDebug.flashSkewMeanMs.toFixed(0)
              : 'n/a'
          } (${elapsed}ms)`,
      )
      // G1: the SHAPE of the samples, printed beside the extreme that gates them.
      const dists = reportDists(run.report)
      results[results.length - 1].dists = dists
      console.error(
        `      ${fmtDist('render', dists.render)} ${fmtDist('inst', dists.instant)} ` +
          `${fmtDist('trim', dists.trimmed)} · ${loadLine(run.load)}`,
      )
      if (!gate.pass) {
        console.error('  failures:', gate.failures.join('; '))
        if (cold === 1) {
          process.stdout.write(
            JSON.stringify(
              {
                // G6a-d: the WORD, first. A red that could not be reproduced is
                // not a regression and must never be read as one.
                verdict: run.inconclusive ? 'INCONCLUSIVE' : 'FAIL',
                inconclusive: run.inconclusive ?? false,
                disagreedDimensions: run.disagreed ?? [],
                load: run.load ?? null,
                preflight,
                confirm: run.confirm ?? run.confirmedBy ?? null,
                gate,
                report: run.report,
              },
              null,
              2,
            ) + '\n',
          )
          process.exitCode = 1
          return
        }
        /**
         * A COLD MATRIX USED TO THROW AWAY THE ONE RUN WORTH READING (GATE-alias,
         * 2026-08-25). With `cold > 1` a failing run printed its failure strings
         * and nothing else, so diagnosing an intermittent flake meant rerunning
         * the whole matrix and hoping to catch it at `--cold=1`. Three sessions'
         * worth of cold flakes have now been argued about from a single summary
         * line. The full report — both reference skews, every pairing, the rig
         * debug block — goes to a file instead.
         */
        const dump = `/tmp/oracle-fail-${Date.now()}-${i + 1}.json`
        try {
          writeFileSync(dump, JSON.stringify({ gate, report: run.report }, null, 2))
          console.error(`  full report: ${dump}`)
        } catch (err) {
          console.error(`  (could not write the failing run's report: ${err?.message ?? err})`)
        }
      }
    }

    const passed = results.filter((r) => r.gate.pass).length
    /**
     * A DIMENSION RED IN SOME RUNS AND GREEN IN OTHERS IS A COIN FLIP, NOT A
     * FINDING (task G6a-d). A cold matrix is already the repetition a single
     * cell has to buy, so its disagreements are free to count — and until now
     * nothing counted them: `--cold=20` printed 14 PASS / 6 FAIL and left the
     * reader to decide, which is exactly how `export throughput` (0.46-0.94x
     * loaded, 0.51-0.82x idle) and `spur` (25 dB of movement) were argued about
     * for three sessions.
     */
    const measured = results.filter((r) => !r.error)
    const dimCounts = new Map()
    for (const r of measured) {
      for (const d of dimensionsOf(r.gate.failures)) dimCounts.set(d, (dimCounts.get(d) ?? 0) + 1)
    }
    const flaky = [...dimCounts.entries()]
      .filter(([, n]) => n > 0 && n < measured.length)
      .map(([d, n]) => ({ dimension: d, redRuns: n, ofRuns: measured.length }))
    const consistent = [...dimCounts.entries()]
      .filter(([, n]) => n === measured.length && measured.length > 0)
      .map(([d]) => d)
    const matrixInconclusive = cold > 1 && flaky.length > 0
    const singleInconclusive = cold === 1 && results.some((r) => r.inconclusive)
    const verdict =
      matrixInconclusive || singleInconclusive ? 'INCONCLUSIVE' : passed === cold ? 'PASS' : 'FAIL'
    const summary = {
      verdict,
      preflight,
      load: results.map((r) => r.load ?? null),
      flakyDimensions: flaky,
      consistentlyRedDimensions: consistent,
      // G4: WHICH CELL. A report whose length is not in it is a report the next
      // session has to guess at, and the guess has always been 6 s.
      recordMs,
      trimMs,
      runs: cold,
      passed,
      failed: cold - passed,
      aliased: results.filter((r) => r.gate.metrics.aliased).length,
      incompleteMetrics: results.filter((r) =>
        oracleMetricsIncomplete(r.gate.metrics ?? {}),
      ).length,
      syncMeans: results.map((r) => r.gate.metrics.syncMeanMs),
      syncMaxAbs: results.map((r) => r.gate.metrics.syncMaxAbsMs),
      spurPeakDb: results.map((r) => r.gate.metrics.spurPeakDb),
      maxBoundaryJump: results.map((r) => r.gate.metrics.maxBoundaryJump),
      tailDurationDeltaMs: results.map((r) => r.gate.metrics.tailDurationDeltaMs),
      tailLastFlashToEndMs: results.map((r) => r.gate.metrics.tailLastFlashToEndMs),
      exportRealtimeFactor: results.map((r) => r.gate.metrics.exportRealtimeFactor),
      exportPeakOutputBytes: results.map((r) => r.gate.metrics.exportPeakOutputBytes),
      trimmedPath: results.map((r) => r.gate.metrics.trimmedPath),
      trimmedSyncMeanMs: results.map((r) => r.gate.metrics.trimmedSyncMeanMs),
      instantPath: results.map((r) => r.gate.metrics.instantPath),
      instantSyncMeanMs: results.map((r) => r.gate.metrics.instantSyncMeanMs),
      instantSyncMaxAbsMs: results.map((r) => r.gate.metrics.instantSyncMaxAbsMs),
      trimmedSyncMaxAbsMs: results.map((r) => r.gate.metrics.trimmedSyncMaxAbsMs),
      compositeStartOffsetMs: results.map((r) => r.gate.metrics.compositeStartOffsetMs),
      // G1: every run's per-pair offsets, so a verdict about the STATISTIC can
      // be reached from one matrix instead of re-run and re-argued.
      dists: results.map((r) => r.dists ?? null),
      // So a session can budget the cell instead of discovering its cost.
      elapsedMs: results.map((r) => r.elapsedMs),
      port,
    }
    /**
     * THE ALL-NULL FAMILY, MADE LOUD (task G4). `incompleteMetrics` counts runs
     * whose CORE metrics came back null, and the gate already fails those. The
     * packet-copy lanes have their own anti-vacuity rules in oracle-gate.mjs (a
     * path that ran unmeasured, or a path that declined). This line exists so
     * the condition is stated on the console rather than inferred from a JSON
     * field nobody scrolls to — a long cell costs minutes, and a session that
     * has just paid them must not have to read a null as a pass.
     */
    if (summary.incompleteMetrics > 0) {
      console.error(
        `oracle: ${summary.incompleteMetrics} of ${cold} run(s) produced NULL core metrics — ` +
          'that is a failed run under contention, not a green one. Re-run when the machine is idle.',
      )
    }
    if (flaky.length > 0) {
      console.error(
        `oracle: INCONCLUSIVE — ${flaky
          .map((f) => `${f.dimension} red in ${f.redRuns}/${f.ofRuns} runs`)
          .join(', ')}. A dimension that flips across identical runs is measuring the MACHINE. ` +
          (consistent.length
            ? `Red in every run, and therefore findings: ${consistent.join(', ')}.`
            : 'Nothing was red in every run, so this matrix reports no finding at all.'),
      )
    }
    console.error(
      `oracle: ${verdict} — ${passed}/${cold} cells green · ${loadLine(results[0]?.load)} at run 1`,
    )
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    if (passed < cold || verdict === 'INCONCLUSIVE') process.exitCode = 1
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    if (viteErr) console.error('--- vite stderr ---\n' + viteErr.slice(-2000))
    process.exitCode = 1
  } finally {
    vite.kill('SIGTERM')
    // Ensure vite dies even if it ignores SIGTERM during startup.
    await sleep(200)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }
}

await main()
