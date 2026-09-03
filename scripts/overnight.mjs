#!/usr/bin/env node
/**
 * THE RUNS THAT NEED A MACHINE NOBODY IS TOUCHING.
 *
 * Robert asked what to run overnight. This is that, armed rather than
 * described: it waits until the machine has actually gone quiet — not until a
 * clock says night — then runs the sequence one rig at a time and leaves one
 * summary behind. Nothing here needs a person.
 *
 * WHY IT WAITS FOR QUIET AND NOT FOR A TIME. Every gate in this repo is a
 * TIMING gate on an 8 GB M3 (scripts/lib/machine.mjs says what that costs), and
 * the runs below are the expensive kind: two 60-minute soaks. Starting one
 * while Robert is still working measures his Chrome, not the product — which is
 * exactly how B10 came back 181-590 ms today and had to be thrown away. So the
 * machine's own load decides, sampled, with a long patience.
 *
 * IT REFUSES RATHER THAN LIES. If the machine never settles inside the wait,
 * nothing runs and the summary says so. A soak measured under load is worse
 * than no soak: somebody would believe it.
 *
 * ORDER, and it is deliberate. The two cheap answers go first so a night that
 * ends early still produces them; the soaks are the bulk; the heavy stop-path
 * gate is last because it is the one nobody is currently blocked on.
 *
 *   1. B10 x3       the editor stall, on a quiet machine at last (~10 min)
 *   2. oracle x20    cold, the flake distribution G6's rule is read against
 *   3. max60 soak    60 min at 3024x1964@60 — a Phase-1 done-criterion
 *   4. max60 soak    again: the criterion is TWO
 *   5. oracle:load   the heavy two-phase stop-path gate
 *
 * Raw output per step goes to /tmp (it is long and it is not truth); `.ai/OVERNIGHT`
 * is rewritten with the verdicts, because that file is for the next agent and
 * .ai holds current truth, never a log.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, createWriteStream, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { busyFraction, loadPerCore, sleep } from './lib/machine.mjs'

// `.pathname` percent-encodes, and this repo lives in a directory with a
// space in its name — the first launch died on `inout%20mvp`.
const REPO = fileURLToPath(new URL('..', import.meta.url))
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)
const RAW = join('/tmp', 'inout-overnight', STAMP)
mkdirSync(RAW, { recursive: true })

/**
 * QUIET MEANS QUIET FOR A WHILE. One sample below the band is a gap between
 * two of his keystrokes; the soaks need an hour, so the entry condition is
 * minutes of calm, and any single busy sample resets it.
 */
const BAND = 0.2
const CALM_SAMPLES = 20
const SAMPLE_MS = 15_000
const MAX_WAIT_MS = 6 * 60 * 60 * 1000

/**
 * `--smoke` PROVES THE MACHINERY, not the product: one real rig through the
 * real gate, no quiet wait, no soak. It exists because the first version of
 * this file was armed on Robert's machine having proved only that it launches
 * and waits — every spawn, lock, log-capture and verdict-extraction path in it
 * was untested when it went live. Run it after ANY edit here.
 */
const SMOKE = process.argv.includes('--smoke')

const STEPS = SMOKE
  ? [
      {
        id: 'smoke-oracle',
        what: 'one oracle run — proves gate, spawn, logging and the report',
        timeoutMs: 10 * 60 * 1000,
        args: ['scripts/oracle.mjs'],
      },
      {
        id: 'smoke-timeout',
        what: 'a step that outlives its budget — proves the tree really dies',
        timeoutMs: 5000,
        args: ['-e', 'setInterval(() => {}, 1000); console.log("smoke: sleeping forever")'],
      },
      {
        id: 'smoke-disk',
        what: 'a step that wants more disk than exists — proves the guard',
        timeoutMs: 60_000,
        args: ['-e', 'console.log("never runs")'],
        needsDiskGb: 100_000,
      },
    ]
  : [
  ...[1, 2, 3].map((i) => ({
    id: `b10-${i}`,
    what: `B10 editor stall, run ${i} of 3 (quiet machine)`,
    timeoutMs: 20 * 60 * 1000,
    args: [
      'scripts/g7-lateness.mjs',
      '--lanes=take,dragcmp',
      '--drag=30',
      '--build',
      "--query=synthetic=1&qstep=max&screensize=3024x1964&prerender=1",
    ],
  })),
  {
    id: 'oracle-cold20',
    what: 'oracle, 20 cold runs — the flake distribution',
    timeoutMs: 60 * 60 * 1000,
    args: ['scripts/oracle.mjs', '--cold=20'],
  },
  ...[1, 2].map((i) => ({
    id: `max60-soak-${i}`,
    what: `60-minute max60 soak ${i} of 2 (Phase-1 done-criterion)`,
    timeoutMs: 100 * 60 * 1000,
    args: [
      'scripts/memory-slope.mjs',
      '--headed',
      '--minutes=60',
      '--screen=3024x1964',
      '--screenfps=60',
      `--out=${join(RAW, `max60-soak-${i}.json`)}`,
    ],
    needsDiskGb: SOAK_NEEDS_GB,
  })),
      {
        id: 'oracle-load',
        what: 'oracle:load — the heavy two-phase stop-path gate',
        timeoutMs: 60 * 60 * 1000,
        args: ['scripts/oracle-load.mjs'],
      },
    ]

/**
 * DISK, BEFORE THE SOAKS AND NOT AFTER.
 *
 * THE THRESHOLD IS BOUNDED, NOT INVENTED — the first version of this file said
 * 30 GB out of nowhere and would have skipped the soaks on a machine with
 * 27.3 GB free. What actually happens: the product's own disk guard
 * (capture/diskGuard.ts) is RATE-based against the browser's OPFS quota and
 * stops a take ~20 s before the next flush would fail, so a soak cannot fill
 * the disk. Robert's real 124.8-minute take averaged 2.41 Mbps ≈ 18 MB/min,
 * so an hour is ~1.1 GB at the shipped rung; even five times that is ~6 GB,
 * and each soak's Chrome profile is temporary and goes with it. 12 GB is that
 * worst case plus room for him.
 *
 * The point of the check is no longer "protect the disk" — the guard does that
 * — it is that a soak which trips the guard measures the GUARD instead of the
 * engine, and that is not the number this run exists for. Free space is
 * recorded either side of every step so the next session reads a measured
 * footprint instead of this estimate.
 */
const SOAK_NEEDS_GB = 12
function freeGb() {
  try {
    const st = statfsSync('/')
    return (st.bavail * st.bsize) / 1e9
  } catch {
    return Infinity
  }
}

const results = []
const t0 = Date.now()

function say(line) {
  console.error(`overnight: ${line}`)
}

/** Wait for sustained calm. Returns false if the machine never gives it. */
async function waitForNight() {
  const start = Date.now()
  let calm = 0
  let announced = false
  while (Date.now() - start < MAX_WAIT_MS) {
    const busy = await busyFraction(2000)
    if (busy <= BAND) {
      calm++
      if (calm >= CALM_SAMPLES) return true
    } else {
      if (calm > 0 && !announced) {
        say(`machine woke up (${(busy * 100).toFixed(0)}% busy) — starting the calm count again`)
        announced = true
      }
      calm = 0
      announced = false
    }
    await sleep(SAMPLE_MS)
  }
  return false
}

function runStep(step) {
  return new Promise((resolve) => {
    const log = join(RAW, `${step.id}.log`)
    const out = createWriteStream(log)
    const started = Date.now()
    const freeBefore = freeGb()
    // THROUGH THE GATE, always: it is the one lock that stops two timing rigs
    // measuring each other, and another session may be awake.
    // ITS OWN PROCESS GROUP, so a timeout can take the WHOLE tree. Killing the
    // bash wrapper alone leaves the rig and its Chrome running: the next step
    // would then start beside a rig that is still measuring, which is the one
    // thing this runner exists to prevent.
    const child = spawn('bash', ['scripts/gate.sh', 'node', ...step.args], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const tail = []
    const keep = (buf) => {
      const s = String(buf)
      out.write(s)
      for (const line of s.split('\n')) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 400) tail.shift()
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const killTree = (sig) => {
      try {
        process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          /* already gone */
        }
      }
    }
    const killer = setTimeout(() => {
      say(`${step.id} passed its ${Math.round(step.timeoutMs / 60000)} min budget — killing it`)
      // TERM first: gate.sh traps it and RELEASES THE LOCK on its way out.
      killTree('SIGTERM')
      setTimeout(() => killTree('SIGKILL'), 10_000).unref()
    }, step.timeoutMs)
    child.on('close', (code) => {
      clearTimeout(killer)
      out.end()
      resolve({
        id: step.id,
        what: step.what,
        code,
        minutes: Math.round((Date.now() - started) / 60000),
        log,
        diskGb: `${freeBefore.toFixed(1)} → ${freeGb().toFixed(1)} GB free`,
        // The verdict lines these rigs print about themselves; the whole
        // output is in the log and does not belong in a summary.
        verdict: tail
          .filter((l) => /PASS|FAIL|verdict|worst second|slope|INCONCLUSIVE|card /i.test(l))
          .slice(-6),
      })
    })
  })
}

function writeReport(state) {
  const lines = [
    '# OVERNIGHT — current truth, rewritten every run (agents only)',
    '',
    `Started ${new Date(t0).toISOString()} · state: ${state}`,
    `Raw output: ${RAW}`,
    '',
  ]
  for (const r of results) {
    lines.push(`## ${r.id} — ${r.what}`)
    lines.push(`exit ${r.code} · ${r.minutes} min${r.diskGb ? ` · ${r.diskGb}` : ''} · ${r.log}`)
    for (const v of r.verdict) lines.push(`  ${v}`)
    lines.push('')
  }
  if (results.length === 0) lines.push('Nothing ran yet.')
  // A smoke run must never overwrite the real night's summary.
  writeFileSync(SMOKE ? join(RAW, 'OVERNIGHT-smoke') : join(REPO, '.ai/OVERNIGHT'), lines.join('\n'))
}

writeReport(SMOKE ? 'smoke test' : 'waiting for the machine to go quiet')
if (!SMOKE)
  say(
  `waiting for ${(CALM_SAMPLES * SAMPLE_MS) / 60000} min of calm below ${BAND * 100}% busy ` +
    `(now ${(await busyFraction(2000) * 100).toFixed(0)}%, load/core ${loadPerCore().toFixed(2)})`,
)

if (!SMOKE && !(await waitForNight())) {
  say('the machine never settled — nothing ran, and that is the honest outcome')
  writeReport('REFUSED: the machine never went quiet, so nothing was measured')
  process.exit(0)
}

say(SMOKE ? 'SMOKE: proving the runner itself, no soaks, no waiting' : 'machine is quiet — starting')
for (const step of STEPS) {
  if (step.needsDiskGb) {
    const free = freeGb()
    if (free < step.needsDiskGb) {
      say(`${step.id} SKIPPED — ${free.toFixed(1)} GB free, it wants ${step.needsDiskGb}`)
      results.push({
        id: step.id,
        what: step.what,
        code: null,
        minutes: 0,
        log: '(not run)',
        verdict: [
          `SKIPPED: ${free.toFixed(1)} GB free on / against ${step.needsDiskGb} GB needed. ` +
            'A soak that fills the disk measures the disk guard, not the engine.',
        ],
      })
      writeReport('running')
      continue
    }
  }
  say(`${step.id}: ${step.what}`)
  results.push(await runStep(step))
  writeReport('running')
}
writeReport('done')
say(`done in ${Math.round((Date.now() - t0) / 60000)} min`)
