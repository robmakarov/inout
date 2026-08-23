import { useEffect, useMemo, useState } from 'react'
import type { QualityTier } from '@core/compose/quality'
import { QUALITY_TIERS, estimateExportBytes, isDefaultTier } from '@core/compose/quality'
import type { Calibration } from '@core/compose/calibrate'
import { estimateFromCalibration } from '@core/compose/calibrate'
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
 * F7c stopped predicting them from a composite a different encoder made — which
 * ran 47 % low on text-heavy takes — and MEASURES them instead: when the panel
 * opens it encodes a few frames of this very take at every step, through the
 * export's own encoder, and prices the file from those. The probe runs in the
 * background and the numbers refine when it lands; it never blocks the panel,
 * and any failure falls straight back to F7's estimate.
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
  // Measured per-step sizes, when they land. Null until then, and null forever
  // on any failure — the panel is useful either way.
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  useEffect(() => {
    let live = true
    const ac = new AbortController()
    void (async () => {
      try {
        const { calibrateSteps } = await import('@core/compose/calibrate')
        const cal = await calibrateSteps(recording, QUALITY_TIERS, { signal: ac.signal })
        if (live && cal) {
          setCalibration(cal)
          console.info(
            `[quality] step sizes measured in ${cal.wallMs}ms from ${cal.sampledAtSec.length} instants`,
          )
        }
      } catch (err) {
        console.warn('[quality] size calibration unavailable', err)
      }
    })()
    return () => {
      live = false
      ac.abort()
    }
  }, [recording])

  const estimates = useMemo(
    () =>
      QUALITY_TIERS.map((t) => ({
        tier: t,
        size:
          estimateFromCalibration(recording, t, outputDurationMs, calibration) ??
          estimateExportBytes(recording, t, outputDurationMs),
      })),
    [recording, outputDurationMs, calibration],
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
