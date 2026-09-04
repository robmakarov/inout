#!/usr/bin/env node
/**
 * EXPERIMENTAL — evaluate an oracle JSON report against CI gates (task oracle-ci).
 *
 * Gates (aligned to oracle-internal thresholds, 2026-07-16):
 *  - sync |offset| ≤ 80 ms on the SYMMETRIC flash+click metric (both rig
 *    references measured, both detection biases removed), falling back to the
 *    old audio-only-corrected metric at ≤60 ms when the symmetric one is
 *    unavailable. The bands differ because the metrics do: the old one
 *    silently omitted a measured ~13.5 ms video reference delay and an exact
 *    18.00 ms detection bias, so it read ~31 ms lower than the truth. Band set
 *    from the measured distribution: 5 cold runs read 40.5-66.2 ms, sd ~8.4,
 *    so 90 sits ~4σ above the mean — tighter in relative terms than the old
 *    60 ms band was on a metric that read 13-31 ms, and it does not flake.
 *    O4's engine work should bring this to <=20 ms; re-tighten it then.
 *  - zero aliased schedule corrections
 *  - audioIntegrity max boundary jump ≤ 0.1
 *  - spur peak ≤ −40 dB
 *  - TAIL INTEGRITY (O8): the exported file must not be shorter than what was
 *    recorded by more than MAX_TAIL_LOSS_MS, and the last fiducial event must
 *    sit within MAX_LAST_EVENT_GAP_MS of the end. Robert 2026-08-22: "Loom cuts
 *    last seconds — we don't do that shit". A pipeline that drops its final
 *    buffer passes every other gate in this file.
 *  - export throughput ≥ MIN_EXPORT_REALTIME (recorded ms per ms of export)
 *  - THE TRIMMED EXPORT (task O5-flip). A trim is the archetypal fast-path edit,
 *    and until now the oracle exported it by calling the renderer directly — so
 *    every sync number this file has ever gated described the path a user gets
 *    LAST. The trimmed file now goes through the product's own ladder, and two
 *    things are checked: its A/V offset against the same band as the full
 *    export, and THAT IT ACTUALLY TOOK THE PATH IT WAS SUPPOSED TO. The second
 *    is not bureaucracy — a fast path that quietly declines would leave the
 *    first gate measuring the render, i.e. passing while proving nothing.
 *  - EXPORT PEAK MEMORY (O8, remainder): the muxer must never hold more than
 *    MAX_EXPORT_PEAK_OUTPUT_BYTES of OUTPUT at once. O1 moved the muxer onto a
 *    chunked OPFS scratch and measured the result — 4.0 MB held against
 *    253.4 MB for the old BufferTarget on a 30-minute take — but nothing
 *    enforced it afterwards, and the failure it guards against is invisible on
 *    a short take: putting the whole file back in one ArrayBuffer costs
 *    nothing at 6 s and OOMs the tab at 30 min. The bound is the scratch's own
 *    chunk size with headroom, so it fails the moment the streaming target is
 *    bypassed rather than when a user's machine runs out.
 */

const MAX_SYNC_ABS_MS = 60
const MAX_SYNC_ABS_SYMMETRIC_MS = 90
/**
 * THE EXTREME IS NO LONGER THE GATE (task G1 + LC1, 2026-09-01).
 *
 * Every sync lane used to fail on `maxAbs = |mean| + (max|dᵢ| − |mean d|)`,
 * which adds the WORST per-event placement error to the systematic offset.
 * Neither half of that addition is a property of the file:
 *   · a flash can only be dated to the frame that shows it, so each pair
 *     carries up to a frame interval of placement error — measured, the 6 s
 *     spread term takes the values 0.0, 16.7 and 33.3 ms and nothing else,
 *     i.e. exactly zero, one or two 30 fps frames;
 *   · `max` over n samples grows with n, and n IS the take length in seconds.
 * Measured on one commit: 6 s takes read mean 36-78 ms with a spread term of
 * 0-33 ms (n≈5), 120 s takes read mean 62.7 ms — the SAME mean — with a
 * spread term of 69 ms (n=99), for 112.2 against a 90 ms band. The file did
 * not get worse; the statistic did.
 *
 * So the band goes on the two things that are properties of the file and do
 * not move with its length: WHERE the audio sits (the mean, band unchanged at
 * 90 ms) and HOW FAR the events scatter around that. Dispersion is expressed
 * in FRAME INTERVALS of the file under test, because the frame grid is what
 * sets the floor — a band in milliseconds would silently mean something
 * different at 60 fps than at 30.
 *
 * BANDS FROM THE MEASURED DISTRIBUTION, 45 lane-runs on one commit (10 cold
 * 6 s runs and 5 cold 120 s runs, three lanes each). Worst reading of each
 * statistic, 6 s → 120 s, in frame intervals:
 *     sd    0.83 → 1.25   (+50 %)
 *     p90   1.34 → 1.94   (+45 %)
 *     MAX   1.34 → 2.60   (+94 %)   ← the one that was banded
 * Bands 2.0 and 3.0: ≥55 % headroom over everything measured, at both lengths.
 * Note what this does and does not claim. sd and p90 are not FLAT across the
 * lengths either — the scatter genuinely widens, because the rig's own
 * reference schedules stop being locked about 20 s into a take (measured: the
 * first 20 pairs of a 120 s cell read 260.7 ms to the decimal, then wander).
 * They grow because the population changed, which is a thing worth reporting;
 * `max` grows because more samples were drawn from the SAME population, which
 * is not. That difference is the whole fix.
 */
const MAX_SYNC_SPREAD_FRAMES = 2.0
const MAX_SYNC_P90_DEV_FRAMES = 3.0
/**
 * A LANE THAT MATCHED ALMOST NOTHING MEASURED ALMOST NOTHING. Observed live on
 * a cold run that the summary counted GREEN: the trimmed lane paired ONE event
 * and passed the band on it, because with a single sample maxAbs is |mean| by
 * construction. Same fault family as the two anti-vacuity rules below — the
 * gate reporting on a file it did not read.
 */
const MIN_MATCHED_PAIRS = 3
const MIN_MATCHED_FRACTION = 0.5
/** Frame interval assumed when the file's own could not be measured. */
const NOMINAL_FRAME_INTERVAL_MS = 1000 / 30
/**
 * A/V DRIFT, ms per second of take — new coverage, not a replacement.
 * A steady ramp centres its own mean and spreads modestly, so it passed the
 * old extreme (a 1 ms/s drift over 120 s reads maxAbs 60 against a 90 band)
 * and it would pass the dispersion bands above too. It is also the ONE sync
 * failure that gets worse the longer the take is in a way that is about the
 * file: 2 ms/s is 6 seconds of desync on a 50-minute take, which is the length
 * this product is being aimed at.
 * MEASURED ON THIS RIG, and why the band is not tighter. One 120 s cell read
 * -0.58 ms/s and looked like a real clock offset. Five did not: across 15
 * lane-runs the slope is +0.40 ± 0.62 ms/s, range -0.35 to +1.62, SIGN
 * INCONSISTENT — a real audio-vs-video clock mismatch does not change
 * direction between takes, so this is the rig's reference wander and the
 * first reading is retracted. 4.0 sits 5.8σ above that mean: it cannot flip
 * on this noise, and it is still 12 seconds of desync across a 50-minute
 * take. THE LIMIT, STATED: a real drift smaller than ~2 ms/s is currently
 * BELOW this instrument's own noise at 120 s. Seeing one needs a longer cell,
 * not a tighter band.
 */
const MAX_SYNC_DRIFT_MS_PER_SEC = 4.0
/** Below this span a slope is not estimable — a 6 s take fits noise. */
const MIN_DRIFT_SPAN_SEC = 30

/**
 * Band the SHAPE of one lane's pairings: enough of them, and not scattered
 * beyond what the frame grid explains. Pushes onto `failures`, records under
 * `metrics` with the lane's prefix. Silent when the analysis predates these
 * fields (an old report is not a failing one).
 */
function gateSyncShape(label, prefix, flashSync, frameIntervalMs, failures, metrics) {
  if (!flashSync || !Array.isArray(flashSync.offsetsMs)) return
  const frame =
    typeof frameIntervalMs === 'number' && frameIntervalMs > 0
      ? frameIntervalMs
      : NOMINAL_FRAME_INTERVAL_MS
  const pairs = flashSync.matchedPairs ?? flashSync.offsetsMs.length
  const flashes = flashSync.flashes ?? 0
  metrics[`${prefix}MatchedPairs`] = pairs
  metrics[`${prefix}Flashes`] = flashes
  metrics[`${prefix}FrameIntervalMs`] = Math.round(frame * 100) / 100
  metrics[`${prefix}SpreadMs`] = flashSync.sdMs ?? null
  metrics[`${prefix}P90DevMs`] = flashSync.p90DevMs ?? null
  metrics[`${prefix}SpreadFrames`] =
    typeof flashSync.sdMs === 'number' ? Math.round((flashSync.sdMs / frame) * 100) / 100 : null
  metrics[`${prefix}P90DevFrames`] =
    typeof flashSync.p90DevMs === 'number'
      ? Math.round((flashSync.p90DevMs / frame) * 100) / 100
      : null

  const floor = Math.max(MIN_MATCHED_PAIRS, Math.ceil(flashes * MIN_MATCHED_FRACTION))
  if (flashes > 0 && pairs < floor) {
    failures.push(
      `${label} sync paired ${pairs} of ${flashes} events (< ${floor}) — too few to be a measurement`,
    )
  }
  if (typeof flashSync.sdMs === 'number') {
    const frames = flashSync.sdMs / frame
    if (frames > MAX_SYNC_SPREAD_FRAMES) {
      failures.push(
        `${label} sync spread sd ${flashSync.sdMs.toFixed(1)}ms = ${frames.toFixed(2)} frame ` +
          `intervals > ${MAX_SYNC_SPREAD_FRAMES} (frame ${frame.toFixed(1)}ms, n=${pairs})`,
      )
    }
  }
  if (typeof flashSync.p90DevMs === 'number') {
    const frames = flashSync.p90DevMs / frame
    if (frames > MAX_SYNC_P90_DEV_FRAMES) {
      failures.push(
        `${label} sync p90 deviation ${flashSync.p90DevMs.toFixed(1)}ms = ${frames.toFixed(2)} ` +
          `frame intervals > ${MAX_SYNC_P90_DEV_FRAMES} (frame ${frame.toFixed(1)}ms, n=${pairs})`,
      )
    }
  }
  metrics[`${prefix}DriftMsPerSec`] = flashSync.driftMsPerSec ?? null
  metrics[`${prefix}DriftR2`] = flashSync.driftR2 ?? null
  metrics[`${prefix}SpanSec`] = flashSync.spanSec ?? null
  if (
    typeof flashSync.driftMsPerSec === 'number' &&
    typeof flashSync.spanSec === 'number' &&
    flashSync.spanSec >= MIN_DRIFT_SPAN_SEC &&
    Math.abs(flashSync.driftMsPerSec) > MAX_SYNC_DRIFT_MS_PER_SEC
  ) {
    failures.push(
      `${label} sync drifts ${flashSync.driftMsPerSec.toFixed(2)}ms per second over ` +
        `${flashSync.spanSec.toFixed(0)}s (> ${MAX_SYNC_DRIFT_MS_PER_SEC}) — ` +
        `${((flashSync.driftMsPerSec * flashSync.spanSec) / 1000).toFixed(2)}s across this take alone`,
    )
  }
}
/** How much shorter than the take the export may be. */
const MAX_TAIL_LOSS_MS = 400
/** The rig fires a flash+beep once per beep interval (987 ms since G5), so the
 *  last one is at most one interval plus a flash duration from the end;
 *  2000 ms leaves room without hiding a dropped tail. */
const MAX_LAST_EVENT_GAP_MS = 2000
/**
 * Export must not be slower than this multiple of realtime.
 *
 * WHERE THIS BAND ACTUALLY SITS, MEASURED (task G6a, 2026-09-02). This gate was
 * the headline coin flip of the flakes pack — 0.46-0.94x on a loaded machine.
 * Eight cold v1 cells with the gate.sh lock held read 1.07 1.19 1.42 1.46 1.00
 * 1.32 1.39 1.43 — 8/8 green, so the flip was the MACHINE and not the engine.
 * But note the minimum: 1.00. The band is not comfortably below the v1
 * distribution, it is AT the bottom of it, and v1 is the slow engine here (the
 * same cell on v2 reads 4.66x). So:
 *   · a single red on this line is not a regression. oracle.mjs re-measures it
 *     and reports INCONCLUSIVE unless the second cell agrees;
 *   · anyone tightening this number needs a fresh distribution first, because
 *     there is no headroom left to spend on v1;
 *   · the number MEANS something (an export slower than realtime is a product
 *     problem, not a statistical one), which is why it was not moved to fit the
 *     data. It is a threshold, not a band fitted to noise.
 */
const MIN_EXPORT_REALTIME = 1.0
/**
 * Output bytes the muxer may hold at once. compose/scratch.ts coalesces writes
 * into 4 MB chunks, so a healthy streamed export peaks near that; 12 MB is
 * three chunks of headroom and still two orders of magnitude below what a
 * whole-file buffer reaches on a long take.
 */
const MAX_EXPORT_PEAK_OUTPUT_BYTES = 12 * 1024 * 1024
const MAX_BOUNDARY_JUMP = 0.1
const MAX_SPUR_DB = -40
/**
 * The rig's beep/flash grid period, ms. READ FROM THE REPORT, not kept here
 * (task G5, 2026-09-01): this file used to carry its own copy of 1000 with a
 * comment telling the reader it "must match oracle/rig.ts", which is a fact
 * with two homes and no way to notice when they disagree — and G5 moved the
 * rig's grid off 1000. The fallback is the old value, for reports recorded
 * before the rig reported its own.
 */
const LEGACY_BEEP_INTERVAL_MS = 1000
const beepIntervalOf = (report) =>
  typeof report?.rigDebug?.beepIntervalMs === 'number' && report.rigDebug.beepIntervalMs > 0
    ? report.rigDebug.beepIntervalMs
    : LEGACY_BEEP_INTERVAL_MS

/** True when gate metrics are missing/NaN — must not pass CI under load. */
export function oracleMetricsIncomplete(metrics) {
  const required = ['syncMeanMs', 'syncMaxAbsMs', 'maxBoundaryJump', 'spurPeakDb']
  return required.some((k) => {
    const v = metrics[k]
    return v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))
  })
}

export function gateOracleReport(report) {
  const failures = []
  const metrics = {}

  // ---- tail integrity + throughput (O8) ----
  const tail = report.tail
  if (tail) {
    metrics.tailDurationDeltaMs = tail.durationDeltaMs
    metrics.tailLastFlashToEndMs = tail.lastFlashToEndMs
    metrics.tailLastOnsetToEndMs = tail.lastOnsetToEndMs
    if (tail.durationDeltaMs < -MAX_TAIL_LOSS_MS) {
      failures.push(
        `tail loss: export is ${-tail.durationDeltaMs}ms shorter than the take (> ${MAX_TAIL_LOSS_MS}ms)`,
      )
    }
    for (const [label, gap] of [
      ['flash', tail.lastFlashToEndMs],
      ['click', tail.lastOnsetToEndMs],
    ]) {
      if (gap === null || gap === undefined) {
        failures.push(`tail: no ${label} found in the export`)
      } else if (gap > MAX_LAST_EVENT_GAP_MS) {
        failures.push(`tail: last ${label} is ${gap}ms before the end (> ${MAX_LAST_EVENT_GAP_MS}ms)`)
      }
    }
  }
  if (report.trimmedPath) {
    metrics.trimmedPath = report.trimmedPath
    metrics.trimmedSyncMeanMs = report.trimmedSyncMeanMs ?? null
    metrics.trimmedSyncMaxAbsMs = report.trimmedSyncMaxAbsMs ?? null
    const band = MAX_SYNC_ABS_SYMMETRIC_MS
    const mean = report.trimmedSyncMeanMs
    if (typeof mean === 'number' && Math.abs(mean) > band) {
      failures.push(
        `trimmed export sync mean |${mean.toFixed(1)}| > ${band}ms (path: ${report.trimmedPath})`,
      )
    }
    // G1: maxAbs is reported (metrics.trimmedSyncMaxAbsMs) and never banded —
    // see MAX_SYNC_SPREAD_FRAMES above for what replaced it.
    gateSyncShape(
      'trimmed export',
      'trimmed',
      report.trimmed?.flashSyncUnbiased ?? report.trimmed?.flashSync,
      report.trimmed?.outFrameIntervalMs,
      failures,
      metrics,
    )
    // GATE-alias: a fast path that RAN but produced no number checked nothing.
    // See the same rule under the instant path for what it was hiding.
    if (report.trimmedPath !== 'render' && !Number.isFinite(mean)) {
      failures.push(
        `trimmed export took '${report.trimmedPath}' but its sync could not be measured — ` +
          'the band above checked nothing',
      )
    }
    // The anti-vacuity check. Only meaningful when the take HAS a composite —
    // without one no packet-copying path can run and the render is correct.
    if (report.hasComposite && report.expectedTrimmedPath) {
      if (report.trimmedPath !== report.expectedTrimmedPath) {
        const why = (report.trimmedPathDeclined ?? [])
          .map((d) => `${d.path}: ${d.reason}`)
          .join(' | ')
        failures.push(
          `trimmed export took '${report.trimmedPath}', expected '${report.expectedTrimmedPath}' — ` +
            `the sync gate above measured the wrong file (${why || 'no reason recorded'})`,
        )
      }
    }
  }
  metrics.compositeFirstPacketSec = report.compositeFirstPacketSec ?? null
  metrics.compositeDurationSec = report.compositeDurationSec ?? null
  metrics.compositeStartOffsetMs = report.compositeStartOffsetMs ?? null
  // P9/O4 — WHICH MACHINERY THIS CELL MEASURED. Carried onto the cell line so a
  // run asked for one rung and silently given another can never be read as
  // evidence for the rung it never used.
  metrics.compositeIntake = report.compositeIntake ?? null
  metrics.compositePainter = report.compositePainter ?? null
  if (report.instantPath) {
    metrics.instantPath = report.instantPath
    metrics.instantSyncMeanMs = report.instantSyncMeanMs ?? null
    metrics.instantSyncMaxAbsMs = report.instantSyncMaxAbsMs ?? null
    // THE INSTANT PATH IS NOW GATED (P0-instant-sync, 2026-08-25). It was
    // measured-but-ungated for one session on purpose — banding a pre-existing
    // defect would have turned CI red on every task. The defect is fixed, so
    // the band goes on: this is the file an unedited export actually produces,
    // and it gets the same ≤90 ms symmetric band as the render.
    const band = MAX_SYNC_ABS_SYMMETRIC_MS
    const mean = report.instantSyncMeanMs
    if (typeof mean === 'number' && Math.abs(mean) > band) {
      failures.push(
        `instant export sync mean |${mean.toFixed(1)}| > ${band}ms (path: ${report.instantPath})`,
      )
    }
    // G1: maxAbs is reported (metrics.instantSyncMaxAbsMs) and never banded —
    // see MAX_SYNC_SPREAD_FRAMES above for what replaced it.
    gateSyncShape(
      'instant export',
      'instant',
      report.instantFlashSync,
      report.instantOutFrameIntervalMs,
      failures,
      metrics,
    )
    /**
     * ANTI-VACUITY, SECOND HALF (GATE-alias, 2026-08-25). The band above is
     * written `typeof mean === 'number'`, so a run where the instant path RAN
     * but its sync could not be measured pushed no failure at all and the run
     * passed — observed in the wild: `inst=instant/n/a trim=smartcut/n/a` on a
     * cold run that the summary counted as green. The path check below catches
     * a path that declined; this catches a path that ran unmeasured. Both are
     * the same fault — the gate reporting on a file it did not read.
     */
    if (report.instantPath === 'instant' && !Number.isFinite(mean)) {
      failures.push(
        'unedited export took the instant path but its sync could not be measured — ' +
          'the band above checked nothing (machine load, decode failure, or a refused correction)',
      )
    }
    // Anti-vacuity, same rule as the trimmed path: a take WITH a composite that
    // renders instead of copying means the gate above measured the wrong file.
    if (report.hasComposite && report.instantPath !== 'instant') {
      const why = (report.instantPathDeclined ?? []).map((d) => `${d.path}: ${d.reason}`).join(' | ')
      failures.push(
        `unedited export took '${report.instantPath}', expected 'instant' — the sync gate above ` +
          `measured the wrong file (${why || 'no reason recorded'})`,
      )
    }
  }
  if (typeof report.exportPeakOutputBytes === 'number') {
    metrics.exportPeakOutputBytes = report.exportPeakOutputBytes
    if (report.exportPeakOutputBytes > MAX_EXPORT_PEAK_OUTPUT_BYTES) {
      failures.push(
        `export held ${(report.exportPeakOutputBytes / 1024 / 1024).toFixed(1)} MB of output in memory ` +
          `(> ${(MAX_EXPORT_PEAK_OUTPUT_BYTES / 1024 / 1024).toFixed(0)} MB) — the streaming scratch was bypassed`,
      )
    }
  }
  if (typeof report.exportRealtimeFactor === 'number') {
    metrics.exportRealtimeFactor = report.exportRealtimeFactor
    if (report.exportRealtimeFactor < MIN_EXPORT_REALTIME) {
      failures.push(
        `export throughput ${report.exportRealtimeFactor}× < ${MIN_EXPORT_REALTIME}× realtime`,
      )
    }
  }

  const full = report.full ?? {}
  const flash = full.flashSync
  if (!flash) {
    failures.push('flash+click sync missing (enable flashClick)')
  } else {
    const rawMean = flash.meanOffsetMs
    const correctedMean = full.flashSyncCorrectedMeanMs
    const correctedMax = full.flashSyncCorrectedMaxAbsMs
    const symMean = full.flashSyncSymmetricMeanMs
    const symMax = full.flashSyncSymmetricMaxAbsMs
    const useSymmetric = symMean !== null && symMean !== undefined && symMax !== null && symMax !== undefined
    const useCorrected = correctedMean !== null && correctedMax !== null
    const syncMean = useSymmetric ? symMean : useCorrected ? correctedMean : rawMean
    const syncMax = useSymmetric ? symMax : useCorrected ? correctedMax : flash.maxAbsOffsetMs
    const band = useSymmetric ? MAX_SYNC_ABS_SYMMETRIC_MS : MAX_SYNC_ABS_MS

    metrics.syncMeanMs = syncMean
    metrics.syncMaxAbsMs = syncMax
    metrics.syncMetric = useSymmetric ? 'symmetric' : useCorrected ? 'audio-corrected' : 'raw'
    metrics.syncBandMs = band
    metrics.syncUsedCorrection = useCorrected
    metrics.syncRawMeanMs = rawMean
    metrics.syncAudioCorrectedMeanMs = correctedMean ?? null

    if (useCorrected && Math.abs(correctedMean - rawMean) > 750) {
      failures.push(
        `aliased schedule correction: raw=${rawMean.toFixed(1)}ms corrected=${correctedMean.toFixed(1)}ms`,
      )
      metrics.aliased = true
    } else {
      metrics.aliased = false
    }

    if (Math.abs(syncMean) > band) {
      failures.push(`sync mean |${syncMean.toFixed(1)}| > ${band}ms (${metrics.syncMetric})`)
    }
    // G1: `syncMax` stays in `metrics` — the worst pair is worth knowing — but a
    // merge no longer hangs on an extreme whose size is set by the take length.
    gateSyncShape(
      'render',
      'render',
      full.flashSyncUnbiased ?? flash,
      full.outFrameIntervalMs,
      failures,
      metrics,
    )
  }

  const integrity = report.audioIntegrity
  if (!integrity) {
    failures.push('audioIntegrity missing')
  } else {
    metrics.maxBoundaryJump = integrity.maxBoundaryJump
    metrics.spurPeakDb = integrity.spurPeakDb
    if (integrity.maxBoundaryJump > MAX_BOUNDARY_JUMP) {
      failures.push(`boundary jump ${integrity.maxBoundaryJump} > ${MAX_BOUNDARY_JUMP}`)
    }
    if (integrity.spurPeakDb !== null && integrity.spurPeakDb > MAX_SPUR_DB) {
      failures.push(`spur ${integrity.spurPeakDb.toFixed(1)} dB > ${MAX_SPUR_DB} dB`)
    }
  }

  /**
   * THE ONE FAILURE MODE THE GRID CANNOT SEE (GATE-alias, 2026-08-25). The
   * AudioContext startup stall is recovered as `arrival mod interval`, which is
   * exact for any stall shorter than one beep interval and WRAPS SILENTLY past
   * it — a 1100 ms stall reads as 100 ms, with full confidence and no symptom.
   * Nothing in the signal can distinguish them, so the honest move is to refuse
   * the run while the stall is still comfortably inside the range rather than
   * to trust a number that might already have wrapped. Measured on this
   * machine: ~130 ms before the rig warmed its encoder, 326-498 ms after, so
   * three quarters of an interval is real headroom and not a hair trigger.
   */
  const stall = report.rigDebug?.audioSkewMeanMs
  if (typeof stall === 'number') {
    const grid = beepIntervalOf(report)
    metrics.audioStallMs = Math.round(stall)
    metrics.beepIntervalMs = grid
    if (Math.abs(stall) > 0.75 * grid) {
      failures.push(
        `AudioContext startup stall ${stall.toFixed(0)}ms is over ${Math.round(0.75 * grid)}ms of the ` +
          `${grid}ms beep grid — past one full interval it wraps silently, so this run ` +
          'is inconclusive rather than green',
      )
    }
  }

  if (oracleMetricsIncomplete(metrics)) {
    failures.push('oracle metrics incomplete (null/NaN — machine load or decode failure)')
  }

  return { pass: failures.length === 0, failures, metrics }
}

if (process.argv[1]?.endsWith('oracle-gate.mjs')) {
  const raw = await new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
    })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
  const report = JSON.parse(raw)
  const result = gateOracleReport(report)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.pass ? 0 : 1)
}
