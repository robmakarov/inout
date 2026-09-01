import { useEffect, useMemo, useRef, useState } from 'react'
import type { QualityTier } from '@core/compose/quality'
import {
  QUALITY_TIERS,
  copySourceForTier,
  estimateExportBytes,
  flooredByPixelOrder,
  isDefaultTier,
  tiersForTake,
} from '@core/compose/quality'
import type { EditState, Recording } from '@core/types'
import type { SizeEstimate } from '@core/compose/quality'
import { humanBytes } from '@app/lib/format'
import { sizeConfidence, sizeNotice, type ProbeState } from '@app/lib/sizeConfidence'
import { QualitySlider } from '@app/components/QualitySlider'
import { Icon } from '@app/components/Icon'
import { useAppStore } from '@app/state/store'

/**
 * EXPORT QUALITY, ON THE SAME SLIDER THE TAKE WAS RECORDED WITH (task UI1).
 *
 * Robert, 2026-08-30: "make same slider of quality, buttons export and for ai
 * right to it not under". So this is the capture screen's control again — same
 * rail, same detents, same names — with the two things a finished take can
 * become sitting beside it instead of stacked underneath.
 *
 * IT IS ALWAYS ON SCREEN NOW. It used to be a panel you reached by pressing
 * Export, chose a step in, and pressed Export again — a step whose only content
 * was a choice the user had already made before recording. The slider is small
 * enough to live under the timeline permanently, so it does.
 *
 * THE LADDER STOPS WHERE THE TAKE DOES. Steps above what the take was recorded
 * under stay on the rail, greyed: those pixels were never captured, so
 * "exporting" at them could only mean upscaling — a bigger file carrying no
 * more picture. See `tierWithinTakeCeiling`.
 *
 * ═ what the numbers are ═
 *
 * F7c MEASURES them rather than predicting them: when this mounts, compose ten
 * seconds of the take through the very geometry the export uses and encode it
 * at every step with the export's own encoder — two consecutive GOPs, so a
 * file's first GOP and its later ones are priced separately and blended by the
 * take's own length. Until it lands (about five seconds) the numbers are F7's
 * model, marked as such, which is why this renders instantly.
 *
 * The DEFAULT step never goes through any of that: it is the composite, copied,
 * so its size is the file and stays exact.
 */
export function QualityBar({
  recording,
  edit,
  outputDurationMs,
  tier,
  frameAspect,
  onTier,
  onExport,
  onExportForAi,
}: {
  recording: Recording
  edit: EditState
  outputDurationMs: number
  tier: QualityTier
  /** The shape this take exports at — the editor's decoded answer where it has
   *  one (F13), so the steps priced here are the steps that will run. */
  frameAspect: number
  onTier: (t: QualityTier) => void
  onExport: () => void
  onExportForAi: () => void
}) {
  /**
   * The measured prices, when they arrive. Started on mount and dropped on
   * unmount: the bar must be usable the instant it appears, so this can only
   * ever REPLACE a number that is already on screen.
   */
  const [measured, setMeasured] = useState<Record<string, SizeEstimate> | null>(null)
  /**
   * F7d: WHETHER THE PROBE IS STILL COMING, which is not the same question as
   * whether it has landed. The first shipping shape only had the answer, so a
   * probe that could not run left "measuring…" on screen forever, over numbers
   * that were never going to be replaced — an audio-only take has no video
   * channel to probe, a take shorter than two frames has nothing to encode, and
   * a browser without a working VideoEncoder has no probe at all.
   */
  const [probe, setProbe] = useState<ProbeState>('running')
  // The edit is read through a ref rather than being a dependency that could
  // restart a five-second probe on an unrelated re-render.
  const editRef = useRef(edit)
  editRef.current = edit

  /**
   * The steps this take may actually export at — already capped by what it was
   * recorded under (UI1) and already resolved against its shape and rate
   * (F13/F15). `tiersForTake` is the ONE place a step is resolved against a
   * take, so nothing here re-resolves anything.
   */
  const tiers = useMemo(() => tiersForTake(recording, frameAspect), [recording, frameAspect])
  const tiersRef = useRef(tiers)
  tiersRef.current = tiers

  useEffect(() => {
    const abort = new AbortController()
    let alive = true
    setMeasured(null)
    setProbe('running')
    // Dynamic, so the probe's decoder + encoder code is not in the bundle this
    // needs to render (O7's first-paint rule, one level down).
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
        if (alive) setProbe('unavailable')
      }
    })()
    return () => {
      alive = false
      abort.abort()
    }
  }, [recording, outputDurationMs])

  const estimates = useMemo(
    () =>
      // B1: the ladder is made coherent BEFORE the confidence is read off it,
      // in both states — the probe's numbers are predictions too, and a
      // measured 1440p below an exact 1080p is the same lie as a modelled one.
      flooredByPixelOrder(
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
            measuredHere: !!m,
          }
        }),
      ).map((e) => ({
        ...e,
        confidence: sizeConfidence({ exact: e.size.exact, measured: e.measuredHere, probe }),
      })),
    [recording, tiers, outputDurationMs, measured, probe],
  )
  const notice = sizeNotice(estimates.map((e) => e.confidence))

  /**
   * THE RAIL SHOWS THE WHOLE LADDER, REACHABLE OR NOT — see the note above. The
   * top detent is the take's own resolution and only exists where the take
   * actually offers one (F18), so it is not on the rail for a take that has no
   * source step to give.
   */
  // The top rung's NAME comes from the tier like every other rung's does —
  // hardcoding 'Max' here is how the step ended up with two names, 'Source' in
  // core and 'Max' on the rail (2026-08-30).
  const source = tiers.find((t) => t.id === 'source')
  const sourceLabel = source?.label
  const rail = useMemo(() => {
    const rungs = QUALITY_TIERS.map((t) => ({ id: t.id, label: t.label }))
    return sourceLabel ? [...rungs, { id: 'source', label: sourceLabel }] : rungs
  }, [sourceLabel])
  const cap = rail.reduce(
    (top, r, i) => (tiers.some((t) => t.id === r.id) ? i : top),
    0,
  )

  const current = estimates.find((e) => e.tier.id === tier.id) ?? estimates[estimates.length - 1]
  const instant = !!current?.copy
  const canPacketCopy = !!estimates.find((e) => isDefaultTier(e.tier))?.copy

  const stops = rail.map((r) => {
    const e = estimates.find((x) => x.tier.id === r.id)
    return {
      id: r.id,
      label: r.label,
      sub: e ? (
        <span className={e.confidence === 'provisional' ? 'qs__label-sub--soft' : undefined}>
          {e.size.exact ? '' : '~'}
          {humanBytes(e.size.bytes)}
        </span>
      ) : undefined,
    }
  })

  /**
   * UI1 — WHAT THE SENTENCE UNDER THE SLIDER USED TO SAY, now the Export
   * button's own tooltip. Robert asked for the caption to go ("second
   * screenshot no need for top and bottom captions") and he is right that it
   * was noise on a control whose sizes already say most of it — but "this one
   * is a copy and takes a second, that one re-renders and takes minutes" is a
   * real difference between two presses of the same button, so it moves onto
   * the button rather than disappearing.
   */
  const exportTitle = [
    instant
      ? 'Copies the video as recorded — no re-encode, ready in about a second, and that size is the file.'
      : `Re-renders the whole video at ${tier.width}×${tier.height}${
          tier.fps >= 60 ? ' at 60 fps' : ''
        }, so the size is an estimate. Longer takes take a while.`,
    notice === 'measuring' ? 'The other sizes are still being measured.' : '',
    notice === 'rough'
      ? `Couldn’t measure the sizes on this take, so they are rough guides.${
          canPacketCopy ? ' The 1080p size is exact.' : ''
        }`
      : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="qbar">
      <QualitySlider
        title="Export quality"
        compact
        stops={stops}
        value={tier.id}
        maxIndex={cap}
        onChange={(id) => {
          const next = tiers.find((t) => t.id === id)
          if (next) onTier(next)
        }}
        lockedHint={() =>
          useAppStore
            .getState()
            .toast('This take was recorded at a lower quality — that step would only upscale it')
        }
        actions={
          <>
            <button className="btn btn--primary qbar__go" onClick={onExport} title={exportTitle}>
              <Icon name="download" size={15} />
              <span>Export</span>
            </button>
            {/* AI1. The second thing a finished take can become, and it is not
                a smaller video: agents don't watch, they sample frames and pay
                about a token per 750 pixels. One PDF — index first, then the
                moments the picture changed — and no settings on purpose. */}
            <button
              className="btn btn--surface qbar__ai"
              onClick={onExportForAi}
              title="One PDF any AI can read: a text index, then the moments the picture actually changed. A few thousand tokens instead of a few hundred thousand."
            >
              <Icon name="doc" size={15} />
              <span>For AI</span>
            </button>
          </>
        }
      />
    </div>
  )
}
