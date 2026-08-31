import type { EditState, Recording } from '@core/types'
import {
  MIN_SEGMENT_MS,
  editSegments,
  outputToRecordingMs,
  recordingToOutputMs,
  splitAtOutputMs,
  type TightenProposal,
} from '@core/timeline'
import { SpeedBar } from '@app/components/SpeedBar'
import { formatClock } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

/**
 * THE EDITING TOOLS, UNDER THE PICTURE (task UI1).
 *
 * Robert, 2026-08-30: "buttons with extra features make under preview video,
 * not in the fucking middle of timeline". They used to sit in a row BETWEEN the
 * lanes and the ruler, which put a bar of buttons through the middle of the one
 * thing on that screen that is a continuous picture of time — the lanes above
 * and the ruler below describe the same axis, and a toolbar wedged between them
 * breaks the read.
 *
 * Nothing about what they DO changed: Split and the speed steps still act on
 * the clip under the playhead (one rule for "which clip does this mean", so the
 * two controls can never disagree) and Tighten still proposes rather than
 * applies. The frame control has since moved OFF this row and onto the stage's
 * right edge — see Player — because its whole subject is the edge of the
 * picture, and it belongs against that edge.
 */
export function ToolsBar({
  recording,
  edit,
  timeMs,
  durationMs,
  onEdit,
  onSeek,
  tighten,
}: {
  recording: Recording
  edit: EditState
  /** Output-domain playhead time. */
  timeMs: number
  /** Output duration. */
  durationMs: number
  onEdit: (next: EditState) => void
  onSeek: (outputMs: number) => void
  /** Silence tightening (F5a). The proposal is preview-only until onApply. */
  tighten?: {
    analysing: boolean
    proposal: TightenProposal | null
    onRun: () => void
    onApply: () => void
    onDismiss: () => void
  }
}) {
  const segments = editSegments(edit)
  /**
   * The clip under the playhead. Via outputToRecordingMs, not trimStart + t:
   * with cuts (and speed) output time is not an offset of recording time, and
   * the old arithmetic was quietly wrong on any take with a cut in it.
   */
  const playheadAt = outputToRecordingMs(edit, Math.min(timeMs, durationMs))
  const playheadSegment =
    playheadAt === null
      ? null
      : segments.findIndex((sg) => playheadAt >= sg.startMs && playheadAt < sg.endMs)
  const activeSegment = playheadSegment === null || playheadSegment < 0 ? null : playheadSegment
  const canSplit =
    playheadAt !== null &&
    segments.some(
      (sg) => playheadAt > sg.startMs + MIN_SEGMENT_MS && playheadAt < sg.endMs - MIN_SEGMENT_MS,
    )

  const hasAudio = recording.channels.some((c) => c.media === 'audio')
  const proposal = tighten?.proposal ?? null

  return (
    <div className="tools">
      <button
        className="tl__tool"
        onClick={() => onEdit(splitAtOutputMs(edit, Math.min(timeMs, durationMs)))}
        disabled={!canSplit}
        title={canSplit ? 'Split at playhead' : 'Move the playhead inside a clip to split'}
      >
        <Icon name="scissors" size={14} />
        <span>Split</span>
      </button>
      {tighten && hasAudio && !proposal && (
        <button
          className="tl__tool"
          onClick={tighten.onRun}
          disabled={tighten.analysing}
          title="Find the silent stretches and propose cuts"
        >
          <Icon name="waves" size={14} />
          <span>{tighten.analysing ? 'Listening…' : 'Tighten'}</span>
        </button>
      )}
      {tighten && proposal && (
        <span className="tl__propose">
          <span className="tl__propose-text">
            {proposal.cutSpans.length} silence{proposal.cutSpans.length === 1 ? '' : 's'} ·{' '}
            −{formatClock(proposal.removedMs)}
          </span>
          <button className="tl__tool tl__tool--go" onClick={tighten.onApply}>
            Apply
          </button>
          <button className="tl__tool" onClick={tighten.onDismiss}>
            Dismiss
          </button>
        </span>
      )}
      {/* F5b: per-clip speed, acting on the clip under the playhead. */}
      {!proposal && (
        <SpeedBar
          edit={edit}
          onEdit={(next) => {
            onEdit(next)
            // Hold the RECORDING instant, not the output one: compressing the
            // clip under the playhead moves every later output time, so keeping
            // the output number would slide the playhead off the clip the user
            // just changed — and the control would light up for a different
            // clip than the one it acted on.
            if (playheadAt !== null) {
              const at = recordingToOutputMs(next, playheadAt)
              if (at !== null) onSeek(at)
            }
          }}
          index={activeSegment}
        />
      )}
      {/* F3's frame control is no longer here: it floats on the right edge of
          the stage now (Player), beside the edge it moves. */}
    </div>
  )
}
