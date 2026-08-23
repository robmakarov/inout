import { useMemo } from 'react'
import type { QualityTier } from '@core/compose/quality'
import { QUALITY_TIERS, estimateExportBytes, isDefaultTier } from '@core/compose/quality'
import type { Recording } from '@core/types'
import { humanBytes } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

/**
 * Quality choice, before the export starts (tasks F7 + F7b).
 *
 * The default tier keeps the instant packet-copy path, so it is labelled
 * "Instant" and everything else says plainly that it re-renders — a 1440p
 * export of a long take is minutes of work, and finding that out afterwards is
 * how a fast tool starts feeling slow.
 *
 * F7b made the ladder finer and made the numbers honest about themselves: the
 * default step's size is the file, every other one is a prediction.
 *
 * F7c tried to MEASURE them instead of predicting them — encode a few frames of
 * the take at each step when the panel opens — and did not clear the ±20 % gate
 * either. The spike and its numbers are in src/experimental/perf/sizeProbe.ts;
 * nothing landed here, because a probe that is 60 % out on motion content is
 * not an improvement on a model that is 20 % out.
 */
export function QualityPanel({
  recording,
  outputDurationMs,
  tier,
  onTier,
  onExport,
  onCancel,
}: {
  recording: Recording
  outputDurationMs: number
  tier: QualityTier
  onTier: (t: QualityTier) => void
  onExport: () => void
  onCancel: () => void
}) {
  const estimates = useMemo(
    () =>
      QUALITY_TIERS.map((t) => ({
        tier: t,
        size: estimateExportBytes(recording, t, outputDurationMs),
      })),
    [recording, outputDurationMs],
  )
  const current =
    estimates.find((e) => e.tier.id === tier.id) ??
    estimates.find((e) => isDefaultTier(e.tier)) ??
    estimates[0]!
  const instant = isDefaultTier(tier)

  return (
    <div className="quality">
      <div className="quality__head">
        <button className="quality__back" onClick={onCancel} aria-label="Back to editing">
          <Icon name="chevron-left" size={18} />
          <span>Editing</span>
        </button>
        <span className="quality__title">Export quality</span>
      </div>

      <div className="quality__tiers" role="radiogroup" aria-label="Export quality">
        {estimates.map(({ tier: t, size }) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={t.id === tier.id}
            className={`quality__tier${t.id === tier.id ? ' quality__tier--on' : ''}`}
            onClick={() => onTier(t)}
          >
            <span className="quality__tier-label">{t.label}</span>
            <span className="quality__tier-size">
              {size.exact ? '' : '~'}
              {humanBytes(size.bytes)}
            </span>
            <span className="quality__tier-tag">{isDefaultTier(t) ? 'Instant' : ''}</span>
          </button>
        ))}
      </div>

      <div className="quality__hint">
        {instant
          ? 'Copies the video as recorded — no re-encode, ready in about a second. That size is the file, not a guess.'
          : `${tier.note ? `${tier.note} ` : ''}Re-renders the whole video at ${tier.width}×${tier.height}, so the size is an estimate. Longer takes take a while.`}
      </div>

      <button className="btn btn--primary btn--wide" onClick={onExport}>
        <Icon name="download" size={16} />
        <span>Export {current.tier.label}</span>
      </button>
    </div>
  )
}
