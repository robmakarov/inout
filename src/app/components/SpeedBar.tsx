import { editSegments, MAX_SEGMENT_SPEED, segmentSpeed, setSegmentSpeed } from '@core/timeline'
import type { EditState } from '@core/types'
import { Icon } from './Icon'

/**
 * Per-clip speed (task F5b).
 *
 * Stepped, not a slider, for the same reason F7b's quality control is: the
 * steps have to be far enough apart to be worth choosing between, and a
 * continuous rate would invite 1.37x, which nobody wants and which makes the
 * export's time-stretch work harder for no audible gain.
 *
 * It acts on the clip under the PLAYHEAD, exactly like Split — one rule for
 * "which clip does this button mean", so the two controls can never disagree.
 */
const STEPS = [1, 1.25, 1.5, 2, 3] as const

export function SpeedBar({
  edit,
  onEdit,
  /** Index into editSegments of the clip under the playhead, or null. */
  index,
}: {
  edit: EditState
  onEdit: (next: EditState) => void
  index: number | null
}): React.ReactElement {
  const segs = editSegments(edit)
  const current = index === null ? 1 : segmentSpeed(segs[index] ?? { startMs: 0, endMs: 0 })
  return (
    <span className="tl__speed" title="Play this clip faster — pitch is preserved">
      <Icon name="gauge" size={14} />
      {STEPS.map((s) => (
        <button
          key={s}
          className={`tl__speed-step${current === s ? ' is-on' : ''}`}
          disabled={index === null || s > MAX_SEGMENT_SPEED}
          onClick={() => {
            if (index === null) return
            onEdit(setSegmentSpeed(edit, index, s))
          }}
          title={s === 1 ? 'Normal speed' : `${s}× — this clip only`}
        >
          {s === 1 ? '1×' : `${s}×`}
        </button>
      ))}
    </span>
  )
}
