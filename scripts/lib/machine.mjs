/**
 * HOW LOADED IS THIS MACHINE, AND DID THAT MOVE THE NUMBER? (task G6a-d.)
 *
 * Every gate in this repo is a TIMING gate on an 8 GB M3, and four of them were
 * measured flipping with load rather than with the code: the v1 oracle's export
 * throughput read 0.46-0.94x loaded against 0.51-0.82x idle, the fidelity
 * render lane went red at 8.69 dB, the spur gate moved 25 dB, and the 120 s
 * cell died on CDP about one run in three. A gate that flips on load is worse
 * than no gate: a session reads the red, believes it, and fixes a bug that does
 * not exist.
 *
 * This module gives the rigs two things, and deliberately not a third.
 *
 *  1. WHAT THE MACHINE WAS DOING. `busyFraction` over a window, from
 *     os.cpus()'s cumulative per-core times — no child process, no sampling
 *     thread, and it counts EVERY process on the machine, which is the point:
 *     the contention that flips these gates comes from the other sessions, not
 *     from ours. A sampler can run for the whole length of a cell and report
 *     the mean and the worst window, so a red always carries the load it was
 *     read under instead of leaving the next session to guess.
 *
 *  2. A BOUNDED WAIT FOR QUIET, before anything is launched. Measured cold on
 *     this machine with the usual overnight agent sessions alive: 0.155-0.165
 *     busy, load1/cpu 0.37-0.39. `QUIET_BUSY` is set from that, and the wait is
 *     BOUNDED and LOUD — on a machine that never goes quiet the run still
 *     happens and says what it was running on, because refusing to measure
 *     forever is its own kind of lie.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is decide, from a load number, whether a
 * red is real. It cannot: our own Chrome and vite are most of the load during a
 * cell — measured, a 6 s oracle cell runs the machine at 42-57 % mean busy all
 * by itself — so "busy" is true by construction while a take is recording. The
 * only honest adjudicator is a SECOND READING: see `disagreement()` below and
 * the confirm loops in oracle.mjs and oracle-fidelity.mjs. Load is context for
 * a verdict, never the verdict.
 */
import os from 'node:os'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Busy fraction this machine reads with nothing of ours running. MEASURED
 * 2026-09-02, six 1 s windows back to back, with the usual overnight agent
 * sessions alive: 0.1554 0.1568 0.1629 0.1585 0.1554 0.1654. The band sits at
 * roughly twice the worst of those — high enough that the machine's own
 * background never trips it, low enough that one other rig rendering does.
 */
export const QUIET_BUSY = 0.35

function cpuTotals() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k]
    idle += c.times.idle
  }
  return { idle, total }
}

/** Fraction of all cores busy over `windowMs` (0..1). */
export async function busyFraction(windowMs = 1000) {
  const a = cpuTotals()
  await sleep(windowMs)
  const b = cpuTotals()
  const dt = b.total - a.total
  if (dt <= 0) return 0
  return Math.max(0, Math.min(1, 1 - (b.idle - a.idle) / dt))
}

/** 1-minute load average per core — free, smoothed, and a second opinion. */
export function loadPerCore() {
  return os.loadavg()[0] / Math.max(1, os.cpus().length)
}

/**
 * Sample the machine for as long as a cell runs. Costs one timer per second and
 * no CPU worth measuring; `stop()` returns the shape of the load the numbers
 * were taken under.
 */
export function startLoadSampler({ everyMs = 1000 } = {}) {
  const samples = []
  let prev = cpuTotals()
  const timer = setInterval(() => {
    const now = cpuTotals()
    const dt = now.total - prev.total
    if (dt > 0) samples.push(Math.max(0, Math.min(1, 1 - (now.idle - prev.idle) / dt)))
    prev = now
  }, everyMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop() {
      clearInterval(timer)
      if (samples.length === 0)
        return { samples: 0, meanBusy: null, maxBusy: null, loadPerCore: loadPerCore() }
      const mean = samples.reduce((s, x) => s + x, 0) / samples.length
      return {
        samples: samples.length,
        meanBusy: Math.round(mean * 1000) / 1000,
        maxBusy: Math.round(Math.max(...samples) * 1000) / 1000,
        loadPerCore: Math.round(loadPerCore() * 100) / 100,
      }
    },
  }
}

/**
 * Wait — bounded — for the machine to go quiet before a cell starts. Returns
 * what it saw either way; the caller decides what to do with a machine that
 * never settles, and every caller in this repo says so on the console rather
 * than pretending the run was clean.
 */
export async function waitForQuiet({
  band = QUIET_BUSY,
  windowMs = 1000,
  maxWaitMs = 60_000,
  label = 'rig',
  log = (m) => console.error(m),
} = {}) {
  const t0 = Date.now()
  let busy = await busyFraction(windowMs)
  if (busy <= band) return { quiet: true, busy, waitedMs: Date.now() - t0, band }
  log(
    `${label}: machine is ${(busy * 100).toFixed(0)}% busy (band ${(band * 100).toFixed(0)}%, ` +
      `load/core ${loadPerCore().toFixed(2)}) — waiting up to ${Math.round(maxWaitMs / 1000)}s for it to settle`,
  )
  while (Date.now() - t0 < maxWaitMs) {
    busy = await busyFraction(windowMs)
    if (busy <= band) {
      const waitedMs = Date.now() - t0
      log(
        `${label}: machine settled to ${(busy * 100).toFixed(0)}% busy after ${(waitedMs / 1000).toFixed(0)}s`,
      )
      return { quiet: true, busy, waitedMs, band }
    }
  }
  const waitedMs = Date.now() - t0
  log(
    `${label}: machine STILL ${(busy * 100).toFixed(0)}% busy after ${(waitedMs / 1000).toFixed(0)}s — ` +
      'running anyway, and every number below carries that load',
  )
  return { quiet: false, busy, waitedMs, band }
}

/**
 * DO TWO READINGS OF THE SAME GATE AGREE? This is the only thing that can tell
 * a flake from a finding on a machine whose load we do not control.
 *
 * Failure strings carry measured numbers, so they are compared by their FIRST
 * WORDS — the dimension, not the value. `export throughput 0.71x < 1x realtime`
 * and `export throughput 0.94x < 1x realtime` are the same finding twice;
 * `spur -35.1 dB > -40 dB` appearing in only one of two runs is not a finding
 * at all.
 */
export function dimensionOf(failure) {
  const words = []
  for (const w of String(failure).split(/\s+/)) {
    // The first token carrying a number is where the dimension ends and the
    // reading begins: `spur -35.1 dB > -40 dB` is the `spur` dimension.
    if (/\d/.test(w)) break
    words.push(w)
    if (words.length === 3) break
  }
  return (words.length ? words : String(failure).split(/\s+/).slice(0, 3)).join(' ').toLowerCase()
}

export function dimensionsOf(failures) {
  return new Set((failures ?? []).map(dimensionOf))
}

/**
 * Compare two readings' failure sets. `agreed` are the dimensions red in both —
 * those are findings. `disagreed` are red in one reading only — those are the
 * coin flip, and a run that has any is INCONCLUSIVE, never green and never a
 * regression.
 */
export function disagreement(failuresA, failuresB) {
  const a = dimensionsOf(failuresA)
  const b = dimensionsOf(failuresB)
  const agreed = [...a].filter((d) => b.has(d))
  const disagreed = [...new Set([...a, ...b])].filter((d) => !(a.has(d) && b.has(d)))
  return { agreed, disagreed }
}

/** One line describing the load a verdict was reached under. */
export function loadLine(stats) {
  if (!stats || stats.samples === 0) return 'load n/a'
  return `load mean ${(stats.meanBusy * 100).toFixed(0)}% max ${(stats.maxBusy * 100).toFixed(0)}% (${stats.samples}s, load/core ${stats.loadPerCore})`
}
