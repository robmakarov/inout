import { describe, expect, it } from 'vitest'
import type { EditState, Recording } from '@core/types'
import { defaultEditState } from '@core/timeline'
import { clickTimesOnOutput, eventsInOutputWindow, type DataChannelSidecar } from './events'

function rec(): Recording {
  return {
    id: 'rec_dc',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'ch_screen',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'k',
        startOffsetMs: 200, // screen media began 200ms after epoch
        durationMs: 9800,
      },
    ],
  }
}

function sidecar(events: DataChannelSidecar['events']): DataChannelSidecar {
  return { v: 1, recordingId: 'rec_dc', epochAbsMs: 0, events }
}

describe('data channel output-time alignment', () => {
  it('maps recording-time events to output time through startOffset and trims', () => {
    const r = rec()
    const e: EditState = {
      ...defaultEditState(r),
      globalTrimStartMs: 1000,
      globalTrimEndMs: 9000,
    }
    const sc = sidecar([
      { t: 500, kind: 'click', x: 1, y: 1, button: 0 }, // before trim -> excluded
      { t: 1500, kind: 'click', x: 2, y: 2, button: 0 }, // -> out 500
      { t: 5000, kind: 'pointer', x: 3, y: 3 }, // -> out 4000
      { t: 9500, kind: 'click', x: 4, y: 4, button: 0 }, // after trim -> excluded
    ])
    const mapped = eventsInOutputWindow(sc, r, e, 0, 8000)
    expect(mapped.map((m) => Math.round(m.outMs))).toEqual([500, 4000])
    expect(clickTimesOnOutput(sc, r, e, 8000).map(Math.round)).toEqual([500])
  })

  it('respects channel trims (blanked regions exclude events)', () => {
    const r = rec()
    const base = defaultEditState(r)
    const e: EditState = {
      ...base,
      channels: base.channels.map((c) => ({ ...c, trimStartMs: 3000 })), // keep local [3000,...)
    }
    // Event at recording t=1000 -> screen-local 800, inside the trimmed-away
    // region -> excluded; event at t=4000 -> local 3800 -> included.
    const sc = sidecar([
      { t: 1000, kind: 'click', x: 0, y: 0, button: 0 },
      { t: 4000, kind: 'click', x: 0, y: 0, button: 0 },
    ])
    const mapped = eventsInOutputWindow(sc, r, e, 0, 10_000)
    expect(mapped).toHaveLength(1)
    expect(Math.round(mapped[0].outMs)).toBe(4000)
  })

  it('returns empty for recordings with no channels', () => {
    const empty: Recording = { id: 'r', createdAt: 0, durationMs: 0, channels: [] }
    const sc = sidecar([{ t: 0, kind: 'pointer', x: 0, y: 0 }])
    expect(eventsInOutputWindow(sc, empty, defaultEditState(empty), 0, 1000)).toEqual([])
  })
})
