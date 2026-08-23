#!/usr/bin/env node
/**
 * EXPERIMENTAL — evaluate an oracle JSON report against CI gates (task oracle-ci).
 *
 * Gates (aligned to oracle-internal thresholds, TD 2026-07-16):
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
 *    sit within MAX_LAST_EVENT_GAP_MS of the end. PO 2026-08-22: "Loom cuts
 *    last seconds — we don't do that shit". A pipeline that drops its final
 *    buffer passes every other gate in this file.
 *  - export throughput ≥ MIN_EXPORT_REALTIME (recorded ms per ms of export)
 */

const MAX_SYNC_ABS_MS = 60
const MAX_SYNC_ABS_SYMMETRIC_MS = 90
/** How much shorter than the take the export may be. */
const MAX_TAIL_LOSS_MS = 400
/** The rig fires a flash+beep every second, so the last one is at most ~1 s
 *  plus a flash duration from the end; 2000 ms leaves room without hiding a
 *  dropped tail. */
const MAX_LAST_EVENT_GAP_MS = 2000
/** Export must not be slower than this multiple of realtime. */
const MIN_EXPORT_REALTIME = 1.0
const MAX_BOUNDARY_JUMP = 0.1
const MAX_SPUR_DB = -40

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
    if (syncMax > band) {
      failures.push(`sync maxAbs ${syncMax.toFixed(1)} > ${band}ms (${metrics.syncMetric})`)
    }
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
