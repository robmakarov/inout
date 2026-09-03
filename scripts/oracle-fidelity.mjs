#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless audio-fidelity oracle (task oracle-audio-fidelity;
 * instant lane: BACKLOG P0 2026-08-25).
 * Ephemeral Vite server only (never :5173 / Robert's shared QA).
 *
 * Gates TWO files:
 *  - the RENDER of a single-source take (the historical gate, bands unchanged);
 *  - the INSTANT packet copy of a composite-bearing multi-source take — the
 *    file a user actually gets by default, which no gate had ever measured.
 *    Its tone band is NOT the render's ±1 dB: the multi-source live mix runs a
 *    shared 0.7 bus (−3.1 dB, pinned by unit test) plus a 12:1 limiter, so the
 *    gate here is a ceiling that catches anything WORSE than that documented
 *    cost (crushing under load, double-gain, a dead lane), while the level
 *    cost itself is Robert's call to change (mix behaviour = Robert gate).
 *  The render of the SAME multi-source take is printed as the A/B (its 1/N bus
 *  reads ~−6 dB by design) but not gated — one take, two files, side by side.
 *
 * Usage: npm run oracle:fidelity
 *        node scripts/oracle-fidelity.mjs --no-composite   # red proof: the
 *          instant lane must FAIL LOUD when it cannot run, not pass vacuously
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { disagreement, loadLine, startLoadSampler, waitForQuiet } from './lib/machine.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FORBIDDEN_PORTS = new Set([5173])

const MAX_TONE_ERROR_DB = 1
const MIN_SEPARATION_DB = 40
/**
 * THE INSTANT LANE IS GATED ON ITS RESIDUAL, NOT ITS RAW TONE ERROR, and the
 * measurement is why (2026-08-26).
 *
 * The backlog entry predicted ~3.1 dB down — the composite's shared 0.7 bus.
 * Measured, the delivered file does not carry that chain at all: exportInstant
 * copies the composite's VIDEO packets and mixes the audio from the RAW
 * channels through the same certified mixer the render uses, deliberately
 * ("without the composite's uncertified MediaRecorder audio" — instant.ts).
 * So its level cost is the render's own headroom rule, 1/N for N sources
 * (compose/audio.ts mixGainForChannels: −6.02 dB at N=2), and gating the raw
 * error would gate a documented design choice that is Robert's to change.
 *
 * What a gate can honestly say is that nothing ELSE moved the level: measured
 * error minus the designed bus gain must sit inside the same ±1 dB the
 * single-source render lane meets. Crushing under load, a double gain, a lane
 * that stopped contributing — all move this; the 1/N rule does not.
 */
const MAX_BUS_RESIDUAL_DB = 1

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      /* */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${url}`)
}

function runQuiet(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'pipe', cwd: ROOT })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.stderr?.on('data', (d) => {
      err += String(d)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, err, ok: code === 0, code }))
  })
}

function laneMetrics(f, expectedBusDb = 0) {
  return {
    maxToneErrorDb: f?.maxToneErrorDb,
    expectedBusDb,
    busResidualDb: maxBusResidualDb(f, expectedBusDb),
    separationDb: f?.separationDb,
    limiterHits: f?.limiterHits,
    thdDb: f?.thdDb,
    imdDb: f?.imdDb,
    // Where this lane's window actually opened, and where it found the signal.
    // A level number is only as good as its window (see findOnsetSec).
    windowStartSec: f?.windowStartSec,
    onsetSec: f?.onsetSec,
  }
}

/** Worst per-tone deviation from the gain the mix bus is DESIGNED to apply. */
function maxBusResidualDb(f, expectedBusDb) {
  const tones = f?.tones
  if (!Array.isArray(tones) || tones.length === 0) return null
  let worst = 0
  for (const t of tones) {
    if (typeof t?.errorDb !== 'number') return null
    worst = Math.max(worst, Math.abs(t.errorDb - expectedBusDb))
  }
  return Math.round(worst * 1000) / 1000
}

/** The render/instant mix bus: unity for one source, 1/N for N (compose/audio.ts). */
function expectedBusDbFor(audioChannels) {
  return audioChannels > 1 ? 20 * Math.log10(1 / audioChannels) : 0
}

function gateFidelity(report) {
  const f = report.fidelity ?? {}
  const failures = []
  if (f.maxToneErrorDb == null || f.maxToneErrorDb > MAX_TONE_ERROR_DB) {
    failures.push(`tone error ${f.maxToneErrorDb} > ${MAX_TONE_ERROR_DB} dB`)
  }
  if (f.separationDb == null || f.separationDb < MIN_SEPARATION_DB) {
    failures.push(`separation ${f.separationDb} < ${MIN_SEPARATION_DB} dB`)
  }
  if (f.limiterHits == null || f.limiterHits !== 0) {
    failures.push(`limiterHits ${f.limiterHits} ≠ 0`)
  }
  return {
    pass: failures.length === 0 && report.pass === true,
    failures,
    metrics: laneMetrics(f),
  }
}

/**
 * The INSTANT lane: the file a user actually gets. Anti-vacuity first — the
 * lane must have RUN, on the packet-copy path, and decoded — then quality:
 * separation and limiter on the render's own bands (nothing licenses the
 * default export to collapse stereo or clip), and level on the bus residual.
 */
function gateInstantLane(report) {
  const failures = []
  const ct = report.compositeTake
  if (!ct) {
    failures.push('instant lane did not run (compositeTake missing — no gate saw the default export path)')
    return { pass: false, failures, metrics: {} }
  }
  if (!ct.hasComposite) {
    failures.push(`take recorded no composite (engine=${ct.engine}) — instant path cannot run`)
  }
  const lane = ct.instant
  if (!lane) {
    failures.push(`instant export missing${ct.error ? ` (${ct.error})` : ''}`)
    return { pass: false, failures, metrics: { engine: ct.engine } }
  }
  if (lane.path !== 'instant') {
    const why = (lane.declined ?? []).map((d) => `${d.path}: ${d.reason}`).join('; ')
    failures.push(`took '${lane.path}', not the packet copy (declined — ${why}) — the lane measured a path the render gate already covers`)
  }
  const audioChannels = (ct.channelStartOffsetsMs ?? []).filter((c) => !/_screen$/.test(c.id)).length
  const expectedBusDb = expectedBusDbFor(audioChannels)
  const f = lane.fidelity ?? {}
  const metrics = { engine: ct.engine, path: lane.path, audioChannels, ...laneMetrics(f, expectedBusDb) }
  if (!(f.frames > 0)) failures.push('instant file audio did not decode (frames=0)')
  if (metrics.busResidualDb == null || metrics.busResidualDb > MAX_BUS_RESIDUAL_DB) {
    failures.push(
      `level residual ${metrics.busResidualDb} dB > ${MAX_BUS_RESIDUAL_DB} dB past the designed ${expectedBusDb.toFixed(2)} dB bus (${audioChannels} sources)`,
    )
  }
  if (f.separationDb == null || f.separationDb < MIN_SEPARATION_DB) {
    failures.push(`separation ${f.separationDb} < ${MIN_SEPARATION_DB} dB`)
  }
  if (f.limiterHits == null || f.limiterHits !== 0) {
    failures.push(`limiterHits ${f.limiterHits} ≠ 0`)
  }
  return { pass: failures.length === 0, failures, metrics }
}

async function main() {
  // Red proof for the instant-lane gates: without a composite the lane cannot
  // run, and the run must FAIL rather than quietly gate the render alone.
  const noComposite = process.argv.includes('--no-composite')
  try {
    await runQuiet(CHROME, ['--version'])
  } catch {
    console.error('Chrome not found — set CHROME_BIN')
    process.exit(2)
  }

  const port = await allocateEphemeralPort()
  console.error(`oracle-fidelity: ephemeral server on http://${HOST}:${port}`)
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  try {
    await waitForHttp(`http://${HOST}:${port}/experimental.html`, Date.now() + 60_000)

    /**
     * THIS RIG HAD NO RETRY AND NO IDEA WHAT THE MACHINE WAS DOING (task G6b).
     * The render lane was measured going RED from load alone — tone error
     * 8.69 dB, THD −56.8 — on code that was fine, and one reading decided it.
     * Level and distortion numbers come off a real encode on a shared 8 GB
     * machine; they move when something else is rendering. So: wait (bounded,
     * loud) for a quiet machine, sample the load the take actually ran under,
     * and never let ONE reading call a regression.
     */
    const preflight = await waitForQuiet({ label: 'oracle-fidelity', maxWaitMs: 60_000 })

    const measure = async (attempt) => {
      const logDir = join(tmpdir(), `oracle-fidelity-cdp-${Date.now()}-${attempt}`)
      const sampler = startLoadSampler()
      const cdp = await runQuiet(process.execPath, [
        join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
        'oracle-fidelity',
        JSON.stringify({ composite: !noComposite }),
        `--port=${port}`,
        `--logDir=${logDir}`,
      ])
      const load = sampler.stop()
      if (!cdp.ok) {
        return { error: cdp.err?.trim() || `cdp-run exited ${cdp.code}`, load, logDir }
      }
      let report
      try {
        report = JSON.parse(cdp.out.trim())
      } catch (err) {
        return { error: `invalid JSON after ${cdp.out.length} bytes: ${String(err)}`, load, logDir }
      }
      return { report, gate: gateFidelity(report), instantGate: gateInstantLane(report), load, logDir }
    }

    let first = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      first = await measure(attempt)
      if (!first.error) break
      console.error(
        `oracle-fidelity: attempt ${attempt}/3 INSTRUMENT error: ${first.error} — ` +
          `${loadLine(first.load)} · chrome stderr + page console: ${first.logDir}`,
      )
      if (attempt < 3) await sleep(5000)
    }
    if (first.error) {
      console.error(
        `oracle-fidelity: FAIL LOUD — cdp-run died on all 3 attempts. That is the INSTRUMENT, ` +
          `not the mix. Logs: ${first.logDir}`,
      )
      process.exitCode = 1
      return
    }
    const { report, gate, instantGate, load } = first
    const fmtLane = (m) =>
      `toneErr=${m.maxToneErrorDb?.toFixed?.(2)}dB (bus ${m.expectedBusDb?.toFixed?.(2)}, residual ${m.busResidualDb?.toFixed?.(2)}) sep=${m.separationDb?.toFixed?.(1)}dB hits=${m.limiterHits} thd=${m.thdDb?.toFixed?.(1)} imd=${m.imdDb?.toFixed?.(1)} win=${m.windowStartSec}s/onset=${m.onsetSec}s`
    console.error(`${gate.pass ? 'PASS' : 'FAIL'} render(single-source): ${fmtLane(gate.metrics)}`)
    if (!gate.pass) console.error('  failures:', gate.failures.join('; '))
    console.error(
      `${instantGate.pass ? 'PASS' : 'FAIL'} instant(user's default file, engine=${instantGate.metrics.engine ?? 'n/a'}, path=${instantGate.metrics.path ?? 'n/a'}): ${fmtLane(instantGate.metrics)}`,
    )
    if (!instantGate.pass) console.error('  failures:', instantGate.failures.join('; '))
    console.error(
      `info ${loadLine(load)} · preflight ${(preflight.busy * 100).toFixed(0)}% busy${preflight.quiet ? '' : ' (NEVER SETTLED)'}`,
    )

    /**
     * THE SECOND READING (task G6b). Both lanes are levels off a real encode;
     * a red on one reading is a candidate, not a verdict. Failures are compared
     * BY DIMENSION and per lane, so `tone error 8.69 > 1 dB` and
     * `tone error 1.04 > 1 dB` are the same finding twice while a lane red only
     * once is the coin flip this task exists to remove.
     */
    const laneFailures = (g, ig) => [
      ...g.failures.map((f) => `render ${f}`),
      ...ig.failures.map((f) => `instant ${f}`),
    ]
    let verdict = gate.pass && instantGate.pass ? 'PASS' : 'FAIL'
    let confirm = null
    if (verdict === 'FAIL') {
      console.error(
        'oracle-fidelity: RED on one reading — confirming with a second take before calling it a regression',
      )
      const second = await measure('confirm')
      if (second.error) {
        verdict = 'INCONCLUSIVE'
        confirm = { error: second.error, load: second.load }
        console.error(
          `oracle-fidelity: the confirming take could not be measured (${second.error}) — INCONCLUSIVE: ` +
            'the first reading stands unconfirmed and this run says nothing about the mix',
        )
      } else {
        const cmp = disagreement(
          laneFailures(gate, instantGate),
          laneFailures(second.gate, second.instantGate),
        )
        confirm = {
          failures: laneFailures(second.gate, second.instantGate),
          render: second.gate.metrics,
          instant: second.instantGate.metrics,
          load: second.load,
          agreed: cmp.agreed,
          disagreed: cmp.disagreed,
        }
        if (cmp.disagreed.length === 0) {
          console.error(
            `oracle-fidelity: CONFIRMED on a second take — ${cmp.agreed.join(', ')} red in both ` +
              `(${loadLine(load)} / ${loadLine(second.load)}). This is a finding.`,
          )
        } else {
          verdict = 'INCONCLUSIVE'
          console.error(
            `oracle-fidelity: INCONCLUSIVE — the two takes disagree on: ${cmp.disagreed.join(', ')}` +
              (cmp.agreed.length ? ` (both red on: ${cmp.agreed.join(', ')})` : '') +
              `. Reading 2 (${loadLine(second.load)}): render ${fmtLane(second.gate.metrics)} · ` +
              `instant ${fmtLane(second.instantGate.metrics)}` +
              '. THIS RUN SAYS NOTHING ABOUT THE MIX — re-run on a quiet machine.',
          )
        }
      }
    }
    // The decomposition, printed but not gated: capture alone → the live mix
    // the instant path DISCARDS → the render of the same take. Which stage
    // costs what, on one recording.
    const ct = report.compositeTake
    if (ct) {
      const busDb = expectedBusDbFor(
        (ct.channelStartOffsetsMs ?? []).filter((c) => !/_screen$/.test(c.id)).length,
      )
      console.error(`info window floor=${ct.windowSkipSec}s (past every channel's capture start; each lane opens at the later of this and its own onset)`)
      if (ct.rawChannel) {
        console.error(`info raw channel (capture only, unity): ${fmtLane(laneMetrics(ct.rawChannel.fidelity))}`)
      }
      if (ct.compositeAudio) {
        // The 0.7 bus + 12:1 chain the backlog expected the instant lane to
        // read. It is in the composite FILE and not in the exported one.
        console.error(`info composite's own audio (live mix, DISCARDED by every export path): ${fmtLane(laneMetrics(ct.compositeAudio, 20 * Math.log10(0.7)))}`)
      }
      if (ct.render) {
        console.error(`info render(same multi-source take): ${fmtLane(laneMetrics(ct.render.fidelity, busDb))}`)
      }
    }
    console.error(`oracle-fidelity: ${verdict}`)
    process.stdout.write(
      JSON.stringify({ verdict, preflight, load, confirm, gate, instantGate, report }, null, 2) + '\n',
    )
    if (verdict !== 'PASS') process.exitCode = 1
  } finally {
    vite.kill('SIGTERM')
    await sleep(200)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* */
    }
  }
}

await main()
