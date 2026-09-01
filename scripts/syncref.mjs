#!/usr/bin/env node
/**
 * EXPERIMENTAL — what the sync correction is BUILT FROM (task G5, 2026-09-01).
 *
 * The oracle's sync number is
 *
 *     syncMean = unbiasedRawMean − (beepSkew − flashSkew)
 *
 * where each skew is the MEAN of one rig reference schedule's residuals against
 * the nominal 1 s grid. G1 measured what that costs: the beep reference's own
 * residual sd is 43.4 ms against 9.7 / 10.6 for the two things it references,
 * so the standard error of the subtracted constant is ±19 ms at 6 s (n≈5) —
 * most of the 20.9 ms run-to-run scatter of the gate's own headline.
 *
 * This reads the reports `oracle.mjs --dumpDir=` writes and re-derives, OFFLINE
 * and on the SAME takes, what every candidate would have produced. No candidate
 * needs its own matrix: all of them are functions of arrays the run already
 * recorded, so five cold runs decide all of them at once.
 *
 * TWO AXES, NOT ONE. Which SCHEDULE is the reference (lead 2) and which
 * STATISTIC summarises it (leads 1 and 3) are independent questions, and the
 * first moves the LEVEL of every published number while the second moves only
 * its scatter. They are printed as a grid for exactly that reason.
 *
 * Usage:
 *   node scripts/syncref.mjs <dumpDir> [<dumpDir> ...]
 *   node scripts/syncref.mjs --json <dumpDir>      # machine-readable
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const INTERVAL_MS = 1000

/* ── small statistics, spelled out so a reader can check them ─────────────── */

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length
const sd = (xs) => {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
/** Symmetric trimmed mean; frac is dropped from EACH end. */
const trimmedMean = (xs, frac = 0.2) => {
  const v = [...xs].sort((a, b) => a - b)
  const k = Math.floor(v.length * frac)
  const kept = v.length - 2 * k >= 1 ? v.slice(k, v.length - k) : v
  return mean(kept)
}
const maxAbs = (xs) => Math.max(...xs.map(Math.abs))

/** Least-squares fit of a series against its own index: period and residual sd. */
export function fitLine(ys) {
  if (!Array.isArray(ys) || ys.length < 3) {
    return { periodMs: null, residualSdMs: null, maxResidualMs: null }
  }
  const xs = ys.map((_, i) => i)
  const xm = mean(xs)
  const ym = mean(ys)
  const sxx = xs.reduce((s, x) => s + (x - xm) ** 2, 0)
  const sxy = xs.reduce((s, x, i) => s + (x - xm) * (ys[i] - ym), 0)
  const slope = sxy / sxx
  const res = ys.map((y, i) => y - (ym + slope * (xs[i] - xm)))
  return { periodMs: slope, residualSdMs: sd(res), maxResidualMs: maxAbs(res) }
}

/** Pearson r over two equal-length series. */
function corr(a, b) {
  if (a.length < 3) return null
  const am = mean(a)
  const bm = mean(b)
  const num = a.reduce((s, x, i) => s + (x - am) * (b[i] - bm), 0)
  const da = Math.sqrt(a.reduce((s, x) => s + (x - am) ** 2, 0))
  const db = Math.sqrt(b.reduce((s, x) => s + (x - bm) ** 2, 0))
  return da > 0 && db > 0 ? num / (da * db) : null
}

/* ── the schedule, as the shipped estimator sees it ───────────────────────── */

/**
 * Residuals of one reference schedule against the nominal grid, indexed the way
 * `estimateScheduleSkewFromArrivals` indexes them: a beep can only render LATE,
 * so k = floor(arrival / interval) and every later arrival is the next one.
 */
export function gridSkews(arrivals, intervalMs = INTERVAL_MS) {
  if (!Array.isArray(arrivals) || arrivals.length < 2) return null
  const k0 = Math.floor(arrivals[0] / intervalMs)
  if (k0 < 1) return null
  return { k0, skews: arrivals.map((t, i) => t - (k0 + i) * intervalMs) }
}

/** Candidate central statistics for one residual series. */
const ESTIMATORS = {
  mean: (s) => mean(s),
  median: (s) => median(s),
  trimmed20: (s) => trimmedMean(s, 0.2),
}

/**
 * Candidate BEEP references (the flash side has only one probe).
 *  anchor — where the PRODUCTION anchor dated the beep. Shipped since O4b.
 *  clone  — a track-processor clone of the mic track: rig-only, blind to
 *           whatever the production path does after it.
 *  true   — the AudioContext's own render time, mapped to rig time. The
 *           quietest of the three and the furthest upstream.
 */
const BEEP_REFS = {
  anchor: (rd) => rd.beepAnchorRigMs,
  clone: (rd) => rd.beepCloneArrivalsRigMs ?? rd.beepStreamArrivalsRigMs,
  true: (rd) => rd.beepTrueRigMs,
}


/**
 * The per-event reference difference over the events the two schedules SHARE.
 *
 * The shipped constant does not do this: it averages the beep series over its
 * own events and the flash series over its own, so a beep the probe missed (or
 * a flash that arrived after the last beep) shifts the correction by that
 * event's whole deviation divided by n — a bias per run, not noise that
 * averages away inside one.
 */
export function sharedDiffs(run, refName) {
  const beep = run.schedules[refName]
  const flash = run.schedules.flash
  if (!beep || !flash) return null
  const out = []
  for (let i = 0; i < beep.skews.length; i++) {
    const j = beep.k0 + i - flash.k0
    if (j >= 0 && j < flash.skews.length) out.push({ k: beep.k0 + i, d: beep.skews[i] - flash.skews[j] })
  }
  return out.length >= 2 ? out : null
}

/* ── one run ──────────────────────────────────────────────────────────────── */

function laneOf(report, lane) {
  if (lane === 'render') return report?.full?.flashSyncUnbiased ?? report?.full?.flashSync ?? null
  if (lane === 'instant') return report?.instantFlashSync ?? null
  if (lane === 'trimmed')
    return report?.trimmed?.flashSyncUnbiased ?? report?.trimmed?.flashSync ?? null
  return null
}

export function readRun(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const report = raw.report
  if (!report) return { path, ok: false, why: raw.error ?? 'no report' }
  const rd = report.rigDebug ?? {}
  const flash = gridSkews(rd.flashStreamArrivalsRigMs)
  const beeps = {}
  for (const [name, pick] of Object.entries(BEEP_REFS)) beeps[name] = gridSkews(pick(rd) ?? [])
  if (!flash || !beeps.anchor) return { path, ok: false, why: 'reference schedule missing' }

  const lanes = {}
  for (const lane of ['render', 'instant', 'trimmed']) {
    const fs = laneOf(report, lane)
    lanes[lane] = fs
      ? {
          unbiasedMeanMs: fs.meanOffsetMs,
          offsetsMs: fs.offsetsMs ?? null,
          pairSec: fs.pairSec ?? null,
          sdMs: fs.sdMs ?? null,
          p90DevMs: fs.p90DevMs ?? null,
          matchedPairs: fs.matchedPairs ?? (fs.offsetsMs ? fs.offsetsMs.length : null),
          driftMsPerSec: fs.driftMsPerSec ?? null,
        }
      : null
  }

  return {
    path,
    ok: true,
    recordMs: raw.recordMs ?? null,
    engine: raw.engine ?? null,
    pass: raw.gate?.pass ?? null,
    // What the run actually applied, straight out of the report — the check
    // that this file's arithmetic reproduces the shipped estimator.
    appliedBeepSkewMs: rd.audioSkewMeanMs ?? null,
    appliedFlashSkewMs: rd.flashSkewMeanMs ?? null,
    reportedSyncMeanMs: report.full?.flashSyncSymmetricMeanMs ?? null,
    schedules: { flash, ...beeps },
    fits: {
      beepTrue: fitLine(rd.beepTrueRigMs),
      flash: fitLine(rd.flashStreamArrivalsRigMs),
      beepAnchor: fitLine(rd.beepAnchorRigMs),
      beepClone: fitLine(rd.beepCloneArrivalsRigMs ?? rd.beepStreamArrivalsRigMs),
    },
    lanes,
  }
}

/**
 * THE QUESTION A PER-EVENT CORRECTION STANDS OR FALLS ON.
 *
 * If the reference's per-event wander is REAL — the beep genuinely landed that
 * late — the export's own per-event offsets must show the same wander, because
 * the export carries that same audio. Correcting per event then cancels a
 * common term. If instead the wander is noise in the REFERENCE, the export is
 * quiet where the reference is loud, and correcting per event would inject the
 * reference's noise into every pair.
 *
 * The export's events are one per second of file, but their absolute index on
 * the rig grid is unknown by a constant, so every shift that can line them up
 * is tried. THE WINNER MUST EARN IT: support first (most pairs matched), then
 * the least dispersion left behind, and the runner-up's residual is reported
 * beside it so an alignment that won by a hair is visible as one.
 */
export function perEvent(run, lane, refName) {
  const l = run.lanes[lane]
  const beep = run.schedules[refName]
  const flash = run.schedules.flash
  if (!l?.offsetsMs || !l.pairSec || l.offsetsMs.length < 4) return null
  if (!beep || beep.skews.length < 4 || flash.skews.length < 4) return null

  const diffByK = new Map()
  for (let i = 0; i < beep.skews.length; i++) {
    const k = beep.k0 + i
    const j = k - flash.k0
    if (j >= 0 && j < flash.skews.length) diffByK.set(k, beep.skews[i] - flash.skews[j])
  }
  if (diffByK.size < 4) return null

  const t0 = l.pairSec[0]
  const relIdx = l.pairSec.map((t) => Math.round(t - t0))
  const ks = [...diffByK.keys()]
  const scored = []
  for (let shift = Math.min(...ks) - 2; shift <= Math.max(...ks) + 2; shift++) {
    const pairs = []
    for (let i = 0; i < relIdx.length; i++) {
      const d = diffByK.get(relIdx[i] + shift)
      if (d !== undefined) pairs.push([l.offsetsMs[i], d])
    }
    if (pairs.length < 4) continue
    const corrected = pairs.map((p) => p[0] - p[1])
    scored.push({
      shift,
      n: pairs.length,
      r: corr(pairs.map((p) => p[0]), pairs.map((p) => p[1])),
      exportSdMs: sd(pairs.map((p) => p[0])),
      refSdMs: sd(pairs.map((p) => p[1])),
      residualSdMs: sd(corrected),
      syncMeanMs: mean(corrected),
      correctionMs: mean(pairs.map((p) => p[1])),
      maxAbsMs: maxAbs(corrected),
    })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.n - a.n || a.residualSdMs - b.residualSdMs)
  const best = scored[0]
  const runnerUp = scored.find((x) => x.shift !== best.shift) ?? null
  return { ...best, runnerUpResidualSdMs: runnerUp?.residualSdMs ?? null, refEvents: diffByK.size }
}

/* ── aggregation over a matrix ────────────────────────────────────────────── */

const fmt = (x, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : 'n/a')
const pm = (vals, d = 1) =>
  vals.length ? `${fmt(mean(vals), d).padStart(7)} ± ${fmt(sd(vals), d).padStart(5)}` : '     n/a      '

export function report(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const runs = files.map((f) => readRun(join(dir, f)))
  const ok = runs.filter((r) => r.ok)
  const recordMs = ok[0]?.recordMs ?? null
  console.log(
    `\n=== ${dir} — ${ok.length} usable of ${runs.length} runs` +
      (recordMs ? `, ${recordMs} ms take` : ''),
  )
  for (const r of runs.filter((x) => !x.ok)) console.log(`  dead: ${r.path} — ${r.why}`)
  if (!ok.length) return null

  /* 1. THE REFERENCE SCHEDULES THEMSELVES. */
  console.log('\n-- reference schedules, each fitted to its own straight line')
  console.log('   schedule        period ms   residual sd ms (range)     worst   runs')
  for (const key of ['beepTrue', 'flash', 'beepAnchor', 'beepClone']) {
    const fits = ok.map((r) => r.fits[key]).filter((f) => typeof f?.residualSdMs === 'number')
    if (!fits.length) continue
    const rsd = fits.map((f) => f.residualSdMs)
    console.log(
      `   ${key.padEnd(14)}  ${fmt(mean(fits.map((f) => f.periodMs)), 3).padStart(9)}   ` +
        `${fmt(mean(rsd), 2).padStart(7)} (${fmt(Math.min(...rsd), 1)}–${fmt(Math.max(...rsd), 1)})`.padEnd(24) +
        `${fmt(mean(fits.map((f) => f.maxResidualMs)), 1).padStart(6)}   ${fits.length}`,
    )
  }

  /* 2. THE GRID: which reference × which statistic, and what it does to the gate. */
  console.log('\n-- reference × estimator: the correction, and the RENDER lane it produces')
  console.log(
    '   reference  estimator     correction ms      render sync ms     instant ms        trimmed ms      ref resid sd',
  )
  const grid = {}
  const shipped = ok.map((r) => r.reportedSyncMeanMs).filter((x) => typeof x === 'number')
  if (shipped.length) {
    console.log(
      `   ${'AS SHIPPED (from the report itself)'.padEnd(26)} ` +
        `${''.padEnd(16)}   ${pm(shipped)}`,
    )
  }
  for (const refName of Object.keys(BEEP_REFS)) {
    const usable = ok.filter((r) => r.schedules[refName]?.skews?.length >= 2)
    if (!usable.length) continue
    for (const estName of [...Object.keys(ESTIMATORS), 'meanShared', 'medianShared', 'perEvent']) {
      const row = { correction: [], render: [], instant: [], trimmed: [], refResid: [], extra: [] }
      for (const r of usable) {
        if (estName === 'perEvent') {
          for (const lane of ['render', 'instant', 'trimmed']) {
            const p = perEvent(r, lane, refName)
            if (!p) continue
            row[lane].push(p.syncMeanMs)
            if (lane === 'render') {
              row.correction.push(p.correctionMs)
              row.refResid.push(p.residualSdMs)
              row.extra.push(p)
            }
          }
        } else if (estName === 'meanShared' || estName === 'medianShared') {
          const shared = sharedDiffs(r, refName)
          if (!shared) continue
          const ds = shared.map((x) => x.d)
          const c = estName === 'meanShared' ? mean(ds) : median(ds)
          row.correction.push(c)
          row.refResid.push(sd(ds.map((d) => d - c)))
          for (const lane of ['render', 'instant', 'trimmed']) {
            const l = r.lanes[lane]
            if (l && typeof l.unbiasedMeanMs === 'number') row[lane].push(l.unbiasedMeanMs - c)
          }
        } else {
          const f = ESTIMATORS[estName]
          const b = f(r.schedules[refName].skews)
          const fl = f(r.schedules.flash.skews)
          const c = b - fl
          row.correction.push(c)
          row.refResid.push(sd(r.schedules[refName].skews.map((s) => s - b)))
          for (const lane of ['render', 'instant', 'trimmed']) {
            const l = r.lanes[lane]
            if (l && typeof l.unbiasedMeanMs === 'number') row[lane].push(l.unbiasedMeanMs - c)
          }
        }
      }
      grid[`${refName}/${estName}`] = row
      console.log(
        `   ${refName.padEnd(10)} ${estName.padEnd(12)} ${pm(row.correction)}   ${pm(row.render)}   ` +
          `${pm(row.instant)}   ${pm(row.trimmed)}   ${fmt(mean(row.refResid), 1).padStart(6)}`,
      )
    }
  }

  /* 3. PER-EVENT DIAGNOSTICS — is the wander real, and did the alignment earn it? */
  console.log('\n-- per-event alignment, render lane (is the export showing the same wander?)')
  console.log('   reference   pairs/ref   export sd   ref sd     r      residual sd   runner-up')
  for (const refName of Object.keys(BEEP_REFS)) {
    const ps = ok.map((r) => perEvent(r, 'render', refName)).filter(Boolean)
    if (!ps.length) continue
    console.log(
      `   ${refName.padEnd(11)} ${`${Math.round(mean(ps.map((p) => p.n)))}/${Math.round(
        mean(ps.map((p) => p.refEvents)),
      )}`.padEnd(11)} ${fmt(mean(ps.map((p) => p.exportSdMs)), 1).padStart(8)}   ` +
        `${fmt(mean(ps.map((p) => p.refSdMs)), 1).padStart(6)}  ` +
        `${fmt(mean(ps.map((p) => p.r).filter((x) => typeof x === 'number')), 2).padStart(6)}   ` +
        `${fmt(mean(ps.map((p) => p.residualSdMs)), 1).padStart(10)}   ` +
        `${fmt(
          mean(ps.map((p) => p.runnerUpResidualSdMs).filter((x) => typeof x === 'number')),
          1,
        ).padStart(8)}`,
    )
  }

  /* 3b. THE EVENT SETS. The shipped constant averages the beep series over ITS
   *  events and the flash series over ITS events, and the export then measures
   *  a THIRD set. Where those three disagree, the correction is summarising
   *  events the measurement never saw — which is a bias per run, not noise that
   *  averages away within one. */
  console.log('\n-- event sets per run (beep k-range · flash k-range · export pairs · what aligning costs)')
  console.log('   run   beep k       flash k      export   shared   const ms   aligned ms   delta ms')
  for (let i = 0; i < ok.length; i++) {
    const r = ok[i]
    const b = r.schedules.anchor
    const f = r.schedules.flash
    const p = perEvent(r, 'render', 'anchor')
    const constMs = mean(b.skews) - mean(f.skews)
    const bRange = `${b.k0}–${b.k0 + b.skews.length - 1}`
    const fRange = `${f.k0}–${f.k0 + f.skews.length - 1}`
    console.log(
      `   ${String(i + 1).padStart(3)}   ${bRange.padEnd(11)}  ${fRange.padEnd(11)}  ` +
        `${String(r.lanes.render?.matchedPairs ?? '?').padStart(6)}   ` +
        `${String(p?.n ?? '?').padStart(6)}   ${fmt(constMs, 1).padStart(8)}   ` +
        `${fmt(p?.correctionMs, 1).padStart(10)}   ${fmt(p ? p.correctionMs - constMs : null, 1).padStart(8)}`,
    )
  }

  /* 4. THE LEVEL SHIFTS between references — this is the re-baselining cost. */
  console.log('\n-- level shift if the reference changes (mean skew difference, ms)')
  for (const refName of ['clone', 'true']) {
    const gaps = ok
      .filter((r) => r.schedules[refName]?.skews?.length >= 2)
      .map((r) => mean(r.schedules.anchor.skews) - mean(r.schedules[refName].skews))
    if (gaps.length) {
      console.log(
        `   anchor − ${refName.padEnd(6)} ${pm(gaps)} ms   [${gaps.map((g) => fmt(g, 1)).join(' ')}]`,
      )
    }
  }

  /* 5. WHAT THE SHIPPED GATE SEES TODAY — the dispersion bands G1 set. */
  const disp = ok.map((r) => r.lanes.render).filter(Boolean)
  if (disp.length) {
    console.log(
      `\n-- render lane as the gate reads it today: sd ${pm(
        disp.map((d) => d.sdMs).filter((x) => typeof x === 'number'),
      )} ms · p90dev ${pm(disp.map((d) => d.p90DevMs).filter((x) => typeof x === 'number'))} ms · ` +
        `pairs ${Math.round(mean(disp.map((d) => d.matchedPairs ?? 0)))}`,
    )
  }

  return { dir, recordMs, n: ok.length, grid, runs: ok }
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const dirs = args.filter((a) => !a.startsWith('--'))
  if (!dirs.length) {
    console.error('usage: node scripts/syncref.mjs <dumpDir> [<dumpDir> ...] [--json]')
    process.exit(2)
  }
  const out = []
  for (const d of dirs) {
    const r = report(d)
    if (r) out.push(r)
  }
  if (!asJson) return
  process.stdout.write(
    JSON.stringify(
      out.map((o) => ({
        dir: o.dir,
        recordMs: o.recordMs,
        n: o.n,
        grid: Object.fromEntries(
          Object.entries(o.grid).map(([k, v]) => [
            k,
            {
              correctionMs: v.correction,
              renderMs: v.render,
              instantMs: v.instant,
              trimmedMs: v.trimmed,
            },
          ]),
        ),
      })),
      null,
      2,
    ) + '\n',
  )
}

// CLI only when run directly — the pieces above are imported by the unit tests.
if (process.argv[1] && process.argv[1].endsWith('syncref.mjs')) main()
