#!/usr/bin/env node
/**
 * EXPERIMENTAL — evaluate an oracle JSON report against CI gates (task oracle-ci).
 *
 * Gates (aligned to oracle-internal thresholds, TD 2026-07-16):
 *  - sync |offset| ≤ 60 ms (flash+click; corrected when valid, else raw)
 *  - zero aliased schedule corrections
 *  - audioIntegrity max boundary jump ≤ 0.1
 *  - spur peak ≤ −40 dB
 */

const MAX_SYNC_ABS_MS = 60
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

  const full = report.full ?? {}
  const flash = full.flashSync
  if (!flash) {
    failures.push('flash+click sync missing (enable flashClick)')
  } else {
    const rawMean = flash.meanOffsetMs
    const correctedMean = full.flashSyncCorrectedMeanMs
    const correctedMax = full.flashSyncCorrectedMaxAbsMs
    const useCorrected = correctedMean !== null && correctedMax !== null
    const syncMean = useCorrected ? correctedMean : rawMean
    const syncMax = useCorrected ? correctedMax : flash.maxAbsOffsetMs

    metrics.syncMeanMs = syncMean
    metrics.syncMaxAbsMs = syncMax
    metrics.syncUsedCorrection = useCorrected
    metrics.syncRawMeanMs = rawMean

    if (useCorrected && Math.abs(correctedMean - rawMean) > 750) {
      failures.push(
        `aliased schedule correction: raw=${rawMean.toFixed(1)}ms corrected=${correctedMean.toFixed(1)}ms`,
      )
      metrics.aliased = true
    } else {
      metrics.aliased = false
    }

    if (Math.abs(syncMean) > MAX_SYNC_ABS_MS) {
      failures.push(`sync mean |${syncMean.toFixed(1)}| > ${MAX_SYNC_ABS_MS}ms`)
    }
    if (syncMax > MAX_SYNC_ABS_MS) {
      failures.push(`sync maxAbs ${syncMax.toFixed(1)} > ${MAX_SYNC_ABS_MS}ms`)
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
