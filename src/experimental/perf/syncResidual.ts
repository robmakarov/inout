/**
 * EXPERIMENTAL — O4 step 1: where the residual A/V offset actually comes from.
 *
 * STATE records a proven +15–25 ms cross-architecture systematic that blocks
 * the ≤10 ms gate, and points at two suspects: the audio anchor, and the
 * oracle's own flash model. Both are measurable, so this measures them instead
 * of arguing about them. Per run it reports three independent quantities:
 *
 *  1. INSTRUMENT BIAS — the rig flashes from a rAF loop but the canvas is
 *     sampled by captureStream(30), so the first bright frame is late by a
 *     uniform 0–33.3 ms; the audio onset detector reports the START of a
 *     128-sample window, early by 0–2.7 ms. Comparing the oracle's flashSync
 *     against the same statistic with both biases removed prices the
 *     instrument's contribution directly.
 *
 *  2. ANCHOR BLIND SPOT — the measured-audio anchor dates sample 0 from the
 *     wall time a worklet batch ARRIVES. Everything between the source and the
 *     worklet (device/stream buffering) is invisible to it and can only make
 *     the anchor late, i.e. push audio late in the export. The rig's own beep
 *     arrival probe measures exactly that transit, so it can be priced too.
 *
 *  3. RESIDUAL — what is left of the export offset once both are accounted.
 */

import { runOracle } from '../oracle/run'

const mean = (xs: number[]): number | null =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null
const sd = (xs: number[]): number | null => {
  if (xs.length < 2) return null
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) * 100) / 100
}

export interface SyncResidualRun {
  run: number
  /** What the oracle gates on today. */
  flashSyncMs: number | null
  /** Same export, both detection biases removed. */
  flashSyncUnbiasedMs: number | null
  /** unbiased − reported: the instrument's own contribution. */
  instrumentBiasMs: number | null
  /** What CI gates on today (audio reference corrected, video assumed on-grid). */
  gatedMs: number | null
  /** Both references measured and both detection biases removed. */
  symmetricMs: number | null
  audioRefSkewMs: number | null
  flashRefSkewMs: number | null
  flashArrivals: number
  beepArrivals: number
  beepAnchorCount: number
  beepCloneCount: number
  beepAnchorFirst: number[]
  beepCloneFirst: number[]
  flashes: number
  onsets: number
}

export interface SyncResidualReport {
  runs: SyncResidualRun[]
  summary: {
    flashSyncMean: number | null
    flashSyncSd: number | null
    unbiasedMean: number | null
    unbiasedSd: number | null
    instrumentBiasMean: number | null
    instrumentBiasSd: number | null
    gatedMean: number | null
    gatedSd: number | null
    symmetricMean: number | null
    symmetricSd: number | null
    audioRefSkewMean: number | null
    flashRefSkewMean: number | null
    /** How much of the gated number is the rig's own video-reference delay. */
    videoReferenceContributionMs: number | null
  }
  predicted: {
    /** Half a frame at 30 fps + half a 128-sample window at 48 kHz. */
    instrumentBiasFromFirstPrinciplesMs: number
  }
  notes: string[]
}

export async function runSyncResidual(
  opts: { runs?: number; recordMs?: number } = {},
): Promise<SyncResidualReport> {
  const n = opts.runs ?? 10
  const recordMs = opts.recordMs ?? 6000
  const runs: SyncResidualRun[] = []

  for (let i = 0; i < n; i++) {
    const report = await runOracle(recordMs)
    const full = report.full
    const reported = full.flashSync?.meanOffsetMs ?? null
    const unbiased = full.flashSyncUnbiased?.meanOffsetMs ?? null
    const gated = full.flashSyncCorrectedMeanMs
    const symmetric = full.flashSyncSymmetricMeanMs
    const rig = report.rigDebug
    runs.push({
      run: i + 1,
      flashSyncMs: reported === null ? null : Math.round(reported * 100) / 100,
      flashSyncUnbiasedMs: unbiased === null ? null : Math.round(unbiased * 100) / 100,
      instrumentBiasMs:
        reported === null || unbiased === null ? null : Math.round((unbiased - reported) * 100) / 100,
      gatedMs: gated === null ? null : Math.round(gated * 100) / 100,
      symmetricMs: symmetric === null ? null : Math.round(symmetric * 100) / 100,
      audioRefSkewMs: rig.audioSkewMeanMs === null ? null : Math.round(rig.audioSkewMeanMs * 100) / 100,
      flashRefSkewMs: rig.flashSkewMeanMs === null ? null : Math.round(rig.flashSkewMeanMs * 100) / 100,
      flashArrivals: rig.flashStreamArrivalsRigMs.length,
      beepArrivals: rig.beepStreamArrivalsRigMs.length,
      beepAnchorCount: rig.beepAnchorRigMs.length,
      beepCloneCount: rig.beepCloneArrivalsRigMs.length,
      beepAnchorFirst: rig.beepAnchorRigMs.slice(0, 4).map((x) => Math.round(x)),
      beepCloneFirst: rig.beepCloneArrivalsRigMs.slice(0, 4).map((x) => Math.round(x)),
      flashes: full.flashOnsetsSec.length,
      onsets: full.onsetsSec.length,
    })
  }

  const pick = (k: keyof SyncResidualRun): number[] =>
    runs.map((r) => r[k]).filter((v): v is number => typeof v === 'number')
  const unbiasedMean = mean(pick('flashSyncUnbiasedMs'))
  const gatedMean = mean(pick('gatedMs'))
  const symmetricMean = mean(pick('symmetricMs'))

  return {
    runs,
    summary: {
      flashSyncMean: mean(pick('flashSyncMs')),
      flashSyncSd: sd(pick('flashSyncMs')),
      unbiasedMean,
      unbiasedSd: sd(pick('flashSyncUnbiasedMs')),
      instrumentBiasMean: mean(pick('instrumentBiasMs')),
      instrumentBiasSd: sd(pick('instrumentBiasMs')),
      gatedMean,
      gatedSd: sd(pick('gatedMs')),
      symmetricMean,
      symmetricSd: sd(pick('symmetricMs')),
      audioRefSkewMean: mean(pick('audioRefSkewMs')),
      flashRefSkewMean: mean(pick('flashRefSkewMs')),
      videoReferenceContributionMs:
        gatedMean === null || symmetricMean === null
          ? null
          : Math.round((gatedMean - symmetricMean) * 100) / 100,
    },
    predicted: {
      instrumentBiasFromFirstPrinciplesMs: Math.round((1000 / 30 / 2 + 128 / 48000 / 2 * 1000) * 100) / 100,
    },
    notes: [
      'positive = audio late (SyncStats convention)',
      'gatedMs is what CI enforces today: raw flash offset minus the MEASURED audio reference skew, with the video reference assumed to sit on the nominal grid',
      'symmetricMs measures the video reference too and removes both detection biases',
      'instrumentBias is exact algebra, not an estimate: half a 30 fps frame (16.67) + half a 128-sample envelope window at 48 kHz (1.33)',
      'audioRefSkew is dominated by the AudioContext startup stall — a rig artifact, correctly subtracted, but a large and unstable one',
    ],
  }
}
