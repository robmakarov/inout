import { useEffect, useMemo, useRef, useState } from 'react'
import type { QualityTier } from '@core/compose/quality'
import { QUALITY_TIERS, estimateExportBytes, isDefaultTier } from '@core/compose/quality'
import type { EditState, Recording } from '@core/types'
import type { SizeEstimate } from '@core/compose/quality'
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
 * F7c MEASURES them instead of predicting them (attempt 5, shipped 2026-08-25):
 * when the panel opens, compose ten seconds of the take through the very
 * geometry the export uses and encode it at every step with the export's own
 * encoder — two consecutive GOPs, so a file's first GOP and its later ones are
 * priced separately and blended by the take's own length. Until it lands (about
 * five seconds) the panel shows F7's model, which is why the panel still opens
 * instantly.
 *
 * WHY THAT MATTERS MORE THAN IT DID: F7's model is anchored on the COMPOSITE's
 * byte rate, and the composite's encoder changed under it when O4 flipped the
 * default capture engine to v2. Scored against a v2 composite on 24 s takes it
 * reads −71 to −84 % on motion content, i.e. a file 4-5x bigger than the number
 * shown. The probe reads −7 to +6 % on the same takes, both contents, twice
 * over (`npm run exp -- o11 {"takeMs":24000}`).
 *
 * The DEFAULT step never goes through any of this: it is the composite, copied,
 * so its size is the file and stays exact.
 */
export function QualityPanel({
  recording,
  edit,
  outputDurationMs,
  tier,
  onTier,
  onExport,
  onExportForAi,
  onCancel,
}: {
  recording: Recording
  edit: EditState
  outputDurationMs: number
  tier: QualityTier
  onTier: (t: QualityTier) => void
  onExport: () => void
  onExportForAi: () => void
  onCancel: () => void
}) {
  /**
   * The measured prices, when they arrive. Started on open and dropped on
   * close: the panel must be usable the instant it appears, so this can only
   * ever REPLACE a number that is already on screen.
   */
  const [measured, setMeasured] = useState<Record<string, SizeEstimate> | null>(null)
  // The edit is fixed while this panel is open (it sits over the editor), so it
  // is read through a ref rather than being a dependency that could restart a
  // five-second probe on an unrelated re-render.
  const editRef = useRef(edit)
  editRef.current = edit
  useEffect(() => {
    const abort = new AbortController()
    let alive = true
    // Dynamic, so the probe's decoder + encoder code is not in the bundle the
    // panel needs to render (O7's first-paint rule, one level down).
    void (async () => {
      try {
        const { calibrateSteps, estimateFromCalibration } = await import('@core/compose/sizeProbe')
        const calibration = await calibrateSteps(recording, editRef.current, QUALITY_TIERS, {
          signal: abort.signal,
        })
        if (!alive || !calibration) return
        const byTier: Record<string, SizeEstimate> = {}
        for (const t of QUALITY_TIERS) {
          const e = estimateFromCalibration(recording, t, outputDurationMs, calibration)
          if (e) byTier[t.id] = e
        }
        setMeasured(byTier)
      } catch {
        // A probe that cannot run leaves the model's number on screen.
      }
    })()
    return () => {
      alive = false
      abort.abort()
    }
  }, [recording, outputDurationMs])

  const estimates = useMemo(
    () =>
      QUALITY_TIERS.map((t) => {
        const model = estimateExportBytes(recording, t, outputDurationMs)
        // The default step is the composite copied — the number IS the file and
        // no probe can improve on it.
        if (isDefaultTier(t)) return { tier: t, size: model }
        return { tier: t, size: measured?.[t.id] ?? model }
      }),
    [recording, outputDurationMs, measured],
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

      {/* AI1. The second thing a finished take can become, and it is not a
          smaller video: agents don't watch, they sample frames and pay about a
          token per 750 pixels. This makes the cheap artefact instead — one PDF,
          index first, key moments after, no video track — and it has no
          settings on purpose (every parameter is derived from the recording). */}
      <button className="btn btn--surface btn--wide quality__ai" onClick={onExportForAi}>
        <Icon name="doc" size={16} />
        <span>For AI</span>
      </button>
      <div className="quality__hint quality__hint--ai">
        One PDF any AI can read: a text index, then the moments the picture actually changed. No
        video inside — a few thousand tokens instead of a few hundred thousand.
      </div>
    </div>
  )
}
