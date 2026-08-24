#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless pipeline oracle driver (task oracle-ci).
 *
 * Always spawns an ephemeral Vite server on a free port (never reuses a shared
 * dev server — TD 2026-07-16: pointing at :5173 poisoned PO QA). Runs synthetic
 * capture→export→measure via CDP, evaluates CI gates, exits nonzero on failure.
 *
 * Usage:
 *   npm run oracle              # single cold run
 *   npm run oracle:cold         # 20 consecutive cold runs (fresh Chrome profile each)
 *   node scripts/oracle.mjs --headed
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gateOracleReport, oracleMetricsIncomplete } from './oracle-gate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** Reserved for interactive `npm run dev` / PO QA — oracle must never use it. */
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
  for (const a of argv) {
    if (a === '--no-composite') { composite = false; continue }
    if (a.startsWith('--cold=')) cold = Number(a.slice(7))
    else if (a === '--headed') headed = true
    else if (a.startsWith('--engine=')) engine = a.slice(9)
    else if (a.startsWith('--port=')) {
      console.error('oracle: --port is disabled (ephemeral server only; never share with PO QA)')
      process.exit(2)
    }
  }
  return { cold, headed, engine, composite }
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

async function runOracleOnce(port, headed, engine, composite = true) {
  const cdpArgs = [
    join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
    'oracle',
    JSON.stringify({ composite }),
    `--port=${port}`,
  ]
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
    return { error: `invalid JSON: ${String(e)}`, report: null }
  }
}

const METRIC_RETRY_COOLDOWN_MS = 5000
const METRIC_RETRY_MAX = 2

/** Retry when CDP/oracle returns null metrics (load flake) — never exit 0 on all-null. */
async function runOracleOnceGated(port, headed, engine, composite = true) {
  let last = { error: 'no attempt', report: null, gate: null }
  for (let attempt = 1; attempt <= METRIC_RETRY_MAX; attempt++) {
    const t0 = Date.now()
    const { error, report } = await runOracleOnce(port, headed, engine, composite)
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
  const { cold, headed, engine, composite } = parseArgs(process.argv.slice(2))

  try {
    await run(CHROME, ['--version'], { stdio: 'pipe' })
  } catch {
    console.error('Chrome not found — set CHROME_BIN or install Google Chrome')
    process.exit(2)
  }

  const port = await allocateEphemeralPort()
  console.error(`oracle: ephemeral server on http://${HOST}:${port} (isolated from PO QA)`)

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

    for (let i = 0; i < cold; i++) {
      const run = await runOracleOnceGated(port, headed, engine, composite)
      const elapsed = run.elapsedMs ?? 0
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
          } aliased=${m.aliased ?? false} (${elapsed}ms)`,
      )
      if (!gate.pass) {
        console.error('  failures:', gate.failures.join('; '))
        if (cold === 1) {
          process.stdout.write(JSON.stringify({ gate, report: run.report }, null, 2) + '\n')
          process.exitCode = 1
          return
        }
      }
    }

    const passed = results.filter((r) => r.gate.pass).length
    const summary = {
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
      instantSyncMeanMs: results.map((r) => r.gate.metrics.instantSyncMeanMs),
      port,
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
