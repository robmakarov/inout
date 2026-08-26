/**
 * X12's decision rule: given the measured raw-screen rungs, which one (if any)
 * is worth proposing?
 *
 * IT IS A PURE FUNCTION WITH TESTS BECAUSE THE FIRST VERSION WAS WRONG AND THE
 * NUMBERS CAUGHT IT. That version asked only "is the render still the same
 * picture (PSNR ≥40 dB)?" and duly recommended dropping the raw screen channel
 * from 8 Mbps to 2.5 on screen content — where the measured render came out
 * 31.5 % BIGGER. Lower-bitrate VP9 does not hand the render a smaller job; it
 * hands it a noisier one, and quantization noise is expensive to re-encode. A
 * rung that costs disk AND costs the delivered file is strictly worse, and a
 * rule that cannot see that is not a rule.
 *
 * So a rung has to clear THREE bars, not one:
 *   1. the render is still the same picture   (PSNR ≥ SAME_PICTURE_DB)
 *   2. the delivered file does not GROW       (exportDeltaPct ≤ GROWTH_SLACK)
 *   3. the saving is worth the risk           (channelSavingPct ≤ −MIN_SAVING)
 * and if none does, the answer is "keep 8 Mbps", stated with the reason.
 */

export interface RungMeasurement {
  requestedMbps: number
  /** Change in the RAW channel's bytes vs the 8 Mbps rung. Negative = smaller. */
  channelSavingPct: number | null
  /** Change in the DELIVERED file's bytes vs the 8 Mbps rung. */
  exportDeltaPct: number | null
  /** PSNR of the rendered frames against the 8 Mbps rung's render. */
  renderPsnrDb: number | null
}

/** Above this, O11's standing reading is that the two files are one picture. */
export const SAME_PICTURE_DB = 40
/** How much the delivered file may grow before a capture saving is a loss. */
export const GROWTH_SLACK_PCT = 0
/** A rung has to be worth the risk of touching capture at all. */
export const MIN_SAVING_PCT = 10

export interface RungProposal {
  /** The rung to propose, or null to keep the shipped ceiling. */
  rungMbps: number | null
  reason: string
}

export function proposeScreenRung(rungs: RungMeasurement[]): RungProposal {
  const baseline = rungs.find((r) => r.channelSavingPct === null)
  const candidates = rungs.filter(
    (r) =>
      r.channelSavingPct !== null &&
      r.exportDeltaPct !== null &&
      (r.renderPsnrDb === null || r.renderPsnrDb >= SAME_PICTURE_DB) &&
      r.exportDeltaPct <= GROWTH_SLACK_PCT &&
      r.channelSavingPct <= -MIN_SAVING_PCT,
  )
  if (candidates.length === 0) {
    const grew = rungs.filter((r) => (r.exportDeltaPct ?? 0) > GROWTH_SLACK_PCT)
    if (grew.length) {
      return {
        rungMbps: null,
        reason:
          `keep ${baseline?.requestedMbps ?? 8} Mbps: every cheaper rung made the DELIVERED file bigger ` +
          `(${grew.map((r) => `${r.requestedMbps} Mbps → +${r.exportDeltaPct}%`).join(', ')}). ` +
          `A noisier source is a more expensive one to re-encode, so this lever costs disk and the file at once.`,
      }
    }
    return {
      rungMbps: null,
      reason: `keep ${baseline?.requestedMbps ?? 8} Mbps: no cheaper rung saved ≥${MIN_SAVING_PCT}% of the channel without losing the picture.`,
    }
  }
  const best = candidates.reduce((a, b) => (b.requestedMbps < a.requestedMbps ? b : a))
  return {
    rungMbps: best.requestedMbps,
    reason:
      `${best.requestedMbps} Mbps: ${best.channelSavingPct}% off the raw channel, ` +
      `${best.exportDeltaPct}% on the delivered file, render PSNR ${best.renderPsnrDb ?? 'baseline'} dB.`,
  }
}
