import { describe, expect, it } from 'vitest'
import type { ExportAnalysis } from './analyze'
import { diagnoseSyncOutlier } from './syncDiagnostics'
import type { RigDebug } from './rig'

function emptyDebug(): RigDebug {
  return {
    rigEpochAbsMs: 0,
    sessionEpochAbsMs: 0,
    minOffsetMs: 0,
    beepIntervalMs: 1000,
    flashClick: true,
    beepStreamArrivalsRigMs: [],
    clockPairs: [],
    beepCtxSecs: [],
    beepTrueRigMs: [],
    beepScheduleSkewMs: [],
    channels: [],
  }
}

describe('diagnoseSyncOutlier', () => {
  it('classifies −473ms with no skew estimate as instrument dropout', () => {
    const full = {
      flashSync: {
        flashes: 5,
        matchedPairs: 4,
        meanOffsetMs: -473,
        maxAbsOffsetMs: 480,
      },
      flashSyncCorrectedMeanMs: null,
      flashSyncCorrectedMaxAbsMs: null,
      flashOnsetsSec: [1, 2, 3],
    } as ExportAnalysis
    const d = diagnoseSyncOutlier(full, emptyDebug(), undefined)
    expect(d.verdict).toBe('instrument')
    expect(d.correctionApplied).toBe(false)
  })
})
