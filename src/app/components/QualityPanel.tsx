import { useEffect, useMemo, useRef, useState } from 'react'
import type { QualityTier } from '@core/compose/quality'
import {
  DEFAULT_TIER_ID,
  tiersForTake,
  copySourceForTier,
  estimateExportBytes,
  isDefaultTier,
} from '@core/compose/quality'
import type { EditState, Recording } from '@core/types'
import type { SizeEstimate } from '@core/compose/quality'
import { humanBytes } from '@app/lib/format'
import { sizeConfidence, sizeNotice, type ProbeState } from '@app/lib/sizeConfidence'
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
  frameAspect,
  onTier,
  onExport,
  onExportForAi,
  onCancel,
}: {
  recording: Recording
  edit: EditState
  outputDurationMs: number
  tier: QualityTier
  /** The shape this take exports at — the editor's decoded answer where it has
   *  one (F13), so the steps the panel prices are the steps that will run. */
  frameAspect: number
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
  /**
   * F7d: WHETHER THE PROBE IS STILL COMING, which is not the same question as
   * whether it has landed. The first shipping shape only had the answer, so a
   * probe that could not run left "Measuring the other sizes on this take —
   * they settle in a few seconds" on screen forever, over numbers that were
   * never going to be replaced. That is not a slow measurement, it is a wrong
   * sentence: an audio-only take has no video channel to probe, a take shorter
   * than two frames has nothing to encode, and a browser without a working
   * VideoEncoder has no probe at all — and in every one of those the panel
   * promised a correction it could not make.
   */
  const [probe, setProbe] = useState<ProbeState>('running')
  // The edit is fixed while this panel is open (it sits over the editor), so it
  // is read through a ref rather than being a dependency that could restart a
  // five-second probe on an unrelated re-render.
  const editRef = useRef(edit)
  editRef.current = edit
  /**
   * F13: the four steps AT THIS TAKE'S SHAPE. Identical to QUALITY_TIERS on a
   * 16:9 take and on every take with the flag off, so the probe still encodes
   * the same lanes it was measured on.
   */
  const tiers = useMemo(() => tiersForTake(recording, frameAspect), [recording, frameAspect])
  // Read like `editRef`, for the same reason: the probe effect keys on the
  // recording, and re-running it because a memo produced a new array would
  // re-encode every step for nothing.
  const tiersRef = useRef(tiers)
  tiersRef.current = tiers
  useEffect(() => {
    const abort = new AbortController()
    let alive = true
    setMeasured(null)
    setProbe('running')
    // Dynamic, so the probe's decoder + encoder code is not in the bundle the
    // panel needs to render (O7's first-paint rule, one level down).
    void (async () => {
      try {
        const { calibrateSteps, estimateFromCalibration } = await import('@core/compose/sizeProbe')
        const calibration = await calibrateSteps(recording, editRef.current, tiersRef.current, {
          signal: abort.signal,
        })
        if (!alive) return
        const byTier: Record<string, SizeEstimate> = {}
        if (calibration) {
          for (const t of tiersRef.current) {
            const e = estimateFromCalibration(recording, t, outputDurationMs, calibration)
            if (e) byTier[t.id] = e
          }
        }
        // A calibration that priced no step is the same outcome as no
        // calibration: nothing on screen is going to be replaced.
        if (Object.keys(byTier).length === 0) {
          setProbe('unavailable')
          return
        }
        setMeasured(byTier)
        setProbe('measured')
      } catch {
        // A probe that cannot run leaves the model's number on screen — and the
        // panel now says that is what it is looking at.
        if (alive) setProbe('unavailable')
      }
    })()
    return () => {
      alive = false
      abort.abort()
    }
  }, [recording, outputDurationMs])

  /**
   * F7d: until the probe lands, these are F7's MODEL, and that model is anchored
   * on the composite — whose encoder changed when the capture engine flipped
   * (measured −71 to −84 % on motion content, and 15× OVER on a synthetic take).
   * So the interim numbers are marked as such rather than presented as prices.
   * The default step is never interim: it is the file.
   *
   * And when the probe is NOT coming, the shimmer stops and the sentence
   * changes: a number that will never be corrected must not be dressed as one
   * that is about to be. The rule itself is pure and tested — app/lib/
   * sizeConfidence.ts — because it is the only part of this panel that can be
   * wrong without anyone noticing.
   */
  const estimates = useMemo(
    () =>
      tiers.map((t) => {
        const model = estimateExportBytes(recording, t, outputDurationMs)
        // An exact step is a file already on disk — the composite copied, or
        // (O3c) a single raw channel that already holds this tier's geometry —
        // and no probe can improve on it.
        const m = measured?.[t.id]
        const size = model.exact ? model : (m ?? model)
        return {
          tier: t,
          size,
          // O3c: which steps are packet-copyable is the export ladder's own
          // answer, per tier — the badge and the path can no longer disagree.
          copy: copySourceForTier(recording, t),
          confidence: sizeConfidence({ exact: size.exact, measured: !!m, probe }),
        }
      }),
    [recording, tiers, outputDurationMs, measured, probe],
  )
  const notice = sizeNotice(estimates.map((e) => e.confidence))
  const current =
    estimates.find((e) => e.tier.id === tier.id) ??
    estimates.find((e) => isDefaultTier(e.tier)) ??
    estimates[0]!
  /**
   * F7d, found while proving the rough-guide branch on a real build: the
   * default step called itself "Instant" and told the user "that size is the
   * file, not a guess" on a take with NO COMPOSITE — an audio-only take, or one
   * whose composite was refused. compose/choose.ts cannot packet-copy without a
   * copy source, so that export fully renders, and the number shown was the
   * 8 Mbps ceiling: 5.6 MB against a file of a few hundred KB. The panel now
   * asks the same question the export ladder asks — since O3c per tier, so a
   * native-res screen's matching step is labelled instant too.
   */
  const canPacketCopy = !!estimates.find((e) => isDefaultTier(e.tier))?.copy
  const instant = !!current.copy

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
        {estimates.map(({ tier: t, size, confidence, copy }) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={t.id === tier.id}
            className={`quality__tier${t.id === tier.id ? ' quality__tier--on' : ''}${
              confidence === 'provisional' ? ' quality__tier--provisional' : ''
            }`}
            onClick={() => onTier(t)}
          >
            <span className="quality__tier-label">{t.label}</span>
            <span className="quality__tier-size">
              {size.exact ? '' : '~'}
              {humanBytes(size.bytes)}
            </span>
            <span className="quality__tier-tag">{copy ? 'Instant' : ''}</span>
          </button>
        ))}
      </div>

      {notice === 'measuring' && (
        <div className="quality__hint quality__hint--measuring">
          Measuring the other sizes on this take — they settle in a few seconds.
        </div>
      )}
      {notice === 'rough' && (
        <div className="quality__hint quality__hint--rough">
          Couldn’t measure the sizes on this take, so they are rough guides — the file can come out
          several times bigger or smaller.
          {canPacketCopy ? ` The ${DEFAULT_TIER_ID} size is exact.` : ''}
        </div>
      )}
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
