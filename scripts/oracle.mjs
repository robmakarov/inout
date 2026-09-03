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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gateOracleReport, oracleMetricsIncomplete } from './oracle-gate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Reserved for interactive `npm run dev` / Robert's QA — oracle must never use it. */
const FORBIDDEN_PORTS = new Set([5173])

function parseArgs(argv) {
  let cold = 1
  let headed = false
  let engine = ''
  let extraQuery = ''
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
    // A/B A FLAG ON ONE BUILD, not across two (the lesson E2 wrote into
    // oracle-load): two builds differ by more than the flag, and on a machine
    // this size the difference between them is mostly the machine. Passed
    // straight to the page, e.g. `--query=chunked=0`.
    else if (a.startsWith('--query=')) extraQuery = a.slice(8)
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
  return { cold, headed, engine, composite, recordMs, trimMs, dumpDir, extraQuery }
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

async function runOracleOnce(port, headed, engine, composite = true, recordMs = 6000, trimMs = 1483, extraQuery = '') {
  const cdpArgs = [
    join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
    'oracle',
    JSON.stringify({ composite, recordMs, trimMs }),
    `--port=${port}`,
  ]
  if (headed) cdpArgs.push('--headed')
  // Which live-composite engine made the file under test (O4 step 2). An
  // unedited take IS the composite, so this is the one knob that changes what
  // the sync and tail bands are actually measuring.
  const query = [engine ? `engine=${engine}` : '', extraQuery].filter(Boolean).join('&')
  if (query) cdpArgs.push(`--query=${query}`)
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
const METRIC_RETRY_MAX = 2

/** Retry when CDP/oracle returns null metrics (load flake) — never exit 0 on all-null. */
async function runOracleOnceGated(port, headed, engine, composite = true, recordMs = 6000, trimMs = 1483, extraQuery = '') {
  let last = { error: 'no attempt', report: null, gate: null }
  for (let attempt = 1; attempt <= METRIC_RETRY_MAX; attempt++) {
    const t0 = Date.now()
    const { error, report } = await runOracleOnce(port, headed, engine, composite, recordMs, trimMs, extraQuery)
    const elapsed = Date.now() - t0
    if (error || !report) {
      last = { error: error ?? 'no report', report, gate: null, elapsedMs: elapsed, attempt }
      if (attempt < METRIC_RETRY_MAX) {
        console.error(
          `[oracle] attempt ${attempt}/${METRIC_RETRY_MAX} error: ${last.error} — retry in ${METRIC_RETRY_COOLDOWN_MS}ms`,
        )
        await sleep(METRIC_RETRY_COOLDOWN_MS)
        continue
      }
      return last
    }
    const gate = gateOracleReport(report)
    if (!oracleMetricsIncomplete(gate.metrics)) {
      return { error: null, report, gate, elapsedMs: elapsed, attempt }
    }
    const why = gate.failures.join('; ')
    last = { error: `incomplete metrics: ${why}`, report, gate, elapsedMs: elapsed, attempt }
    if (attempt < METRIC_RETRY_MAX) {
      console.error(
        `[oracle] attempt ${attempt}/${METRIC_RETRY_MAX} all-null/incomplete metrics — retry in ${METRIC_RETRY_COOLDOWN_MS}ms`,
      )
      await sleep(METRIC_RETRY_COOLDOWN_MS)
      continue
    }
    console.error(`[oracle] FAIL LOUD: incomplete metrics after ${METRIC_RETRY_MAX} attempts — ${why}`)
    return last
  }
  return last
}

async function main() {
  const { cold, headed, engine, composite, recordMs, trimMs, dumpDir, extraQuery } = parseArgs(process.argv.slice(2))
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

    for (let i = 0; i < cold; i++) {
      const run = await runOracleOnceGated(port, headed, engine, composite, recordMs, trimMs, extraQuery)
      const elapsed = run.elapsedMs ?? 0
      dumpRun(i, {
        run: i + 1,
        recordMs,
        trimMs,
        engine: engine || 'default',
        elapsedMs: elapsed,
        error: run.error ?? null,
        gate: run.gate ?? null,
        report: run.report ?? null,
      })
      if (run.error || !run.report || !run.gate) {
        results.push({
          run: i + 1,
          elapsedMs: elapsed,
          error: run.error,
          gate: run.gate ?? { pass: false, failures: [run.error ?? 'no report'], metrics: {} },
        })
        console.error(`[${i + 1}/${cold}] ERROR ${run.error ?? 'no report'} (${elapsed}ms)`)
        continue
      }
      const gate = run.gate
      results.push({ run: i + 1, elapsedMs: elapsed, gate, report: run.report })
      const m = gate.metrics
      const sync = m.syncMeanMs?.toFixed?.(1) ?? 'n/a'
      const max = m.syncMaxAbsMs?.toFixed?.(1) ?? 'n/a'
      const spur = m.spurPeakDb?.toFixed?.(1) ?? 'n/a'
      const status = gate.pass ? 'PASS' : 'FAIL'
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
          `${fmtDist('trim', dists.trimmed)}`,
      )
      if (!gate.pass) {
        console.error('  failures:', gate.failures.join('; '))
        if (cold === 1) {
          process.stdout.write(JSON.stringify({ gate, report: run.report }, null, 2) + '\n')
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
    const summary = {
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
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    if (passed < cold) process.exitCode = 1
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
