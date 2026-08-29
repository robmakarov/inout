/**
 * O3b — WHICH FILE THE COPY PATHS COPY.
 *
 * A wrong "yes" here ships the user a file of the wrong geometry or a track no
 * MP4 muxer can hold, so every refusal has a test and the ORDER has a test.
 * The one property that matters most is the last block: this decision may only
 * ever ADD a copyable case, never remove one — the composite must still be
 * chosen in exactly the situations it was chosen in before O3b existed.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRecording, CompositeRecording, Recording } from '@core/types'
import { setSingleGenRung } from '@core/singleGen'
import { chooseCopySource, singleGenerationSource } from './copySource'

const OUT = { width: 1920, height: 1080 }

function channel(over: Partial<ChannelRecording> = {}): ChannelRecording {
  return {
    id: 'ch_screen',
    kind: 'screen',
    media: 'video',
    mimeType: 'video/mp4',
    blobKey: 'rec_1_ch_screen.mp4',
    startOffsetMs: 12,
    durationMs: 10_000,
    width: 1920,
    height: 1080,
    ...over,
  }
}

function composite(over: Partial<CompositeRecording> = {}): CompositeRecording {
  return {
    blobKey: 'rec_1_composite.webm',
    mimeType: 'video/mp4',
    durationMs: 9_800,
    width: 1920,
    height: 1080,
    startOffsetMs: 180,
    engine: 'v2',
    ...over,
  }
}

function recording(over: Partial<Recording> = {}): Recording {
  return {
    id: 'rec_1',
    createdAt: 0,
    durationMs: 10_000,
    channels: [channel()],
    ...over,
  } as Recording
}

beforeEach(() => {
  // Storage-backed, so a test that flips it would leak into the next one.
  setSingleGenRung('export')
})

describe('single generation: when one raw channel already IS the composition', () => {
  it('takes the raw channel when it is mp4 at exactly the export geometry', () => {
    const { source, reason } = singleGenerationSource(recording(), OUT)
    expect(reason).toBe('')
    expect(source).toMatchObject({
      origin: 'single-generation',
      blobKey: 'rec_1_ch_screen.mp4',
      width: 1920,
      height: 1080,
      startOffsetMs: 12,
      writer: 'webcodecs',
      tailIncomplete: false,
      channelId: 'ch_screen',
    })
  })

  it('refuses a take with a camera as well — that is what the compositor is for', () => {
    const two = recording({
      channels: [channel(), channel({ id: 'ch_cam', kind: 'camera', blobKey: 'c.mp4' })],
    })
    const { source, reason } = singleGenerationSource(two, OUT)
    expect(source).toBeNull()
    expect(reason).toContain('2 video channels')
  })

  it('refuses a webm raw channel — MediaRecorder VP9 is not copyable into MP4', () => {
    // This is the exact condition O3b waited months for and X6 delivered.
    const vp9 = recording({ channels: [channel({ mimeType: 'video/webm;codecs=vp9' })] })
    const { source, reason } = singleGenerationSource(vp9, OUT)
    expect(source).toBeNull()
    expect(reason).toContain('not mp4')
  })

  it('refuses any geometry but the output’s — otherwise the fit is a resample', () => {
    // A 1280x720 screen is CONTAIN-FITTED into the compositor's 1920x1080
    // canvas, so the composite genuinely is doing work and the raw channel is
    // not the same picture.
    const small = recording({ channels: [channel({ width: 1280, height: 720 })] })
    const { source, reason } = singleGenerationSource(small, OUT)
    expect(source).toBeNull()
    expect(reason).toContain('1280x720')
  })

  it('refuses a channel that never recorded its dimensions', () => {
    const blind = recording({ channels: [channel({ width: undefined, height: undefined })] })
    expect(singleGenerationSource(blind, OUT).source).toBeNull()
  })

  it('refuses an empty channel', () => {
    const empty = recording({ channels: [channel({ durationMs: 0 })] })
    expect(singleGenerationSource(empty, OUT).source).toBeNull()
  })

  it('refuses an audio-only take', () => {
    const audioOnly = recording({
      channels: [channel({ id: 'ch_mic', kind: 'mic', media: 'audio', mimeType: 'audio/webm' })],
    })
    const { source, reason } = singleGenerationSource(audioOnly, OUT)
    expect(source).toBeNull()
    expect(reason).toContain('no video channel')
  })
})

describe('the order is the policy', () => {
  it('prefers the raw channel over the composite when the take qualifies', () => {
    const both = recording({ composite: composite() })
    const chosen = chooseCopySource(both, OUT)
    expect(chosen.source?.origin).toBe('single-generation')
    expect(chosen.declined).toEqual([])
  })

  it('falls back to the composite and says why single generation was refused', () => {
    const withCamera = recording({
      composite: composite(),
      channels: [channel(), channel({ id: 'ch_cam', kind: 'camera', blobKey: 'c.mp4' })],
    })
    const chosen = chooseCopySource(withCamera, OUT)
    expect(chosen.source?.origin).toBe('composite')
    expect(chosen.declined[0]?.origin).toBe('single-generation')
    expect(chosen.declined[0]?.reason).toContain('2 video channels')
  })

  it('honours ?singlegen=off by going straight to the composite', () => {
    setSingleGenRung('off')
    const both = recording({ composite: composite() })
    const chosen = chooseCopySource(both, OUT)
    expect(chosen.source?.origin).toBe('composite')
    expect(chosen.declined[0]?.reason).toContain('disabled by flag')
  })

  it('has nothing to copy when a non-qualifying take has no composite either', () => {
    const neither = recording({ channels: [channel({ mimeType: 'video/webm;codecs=vp9' })] })
    const chosen = chooseCopySource(neither, OUT)
    expect(chosen.source).toBeNull()
    expect(chosen.declined.map((d) => d.origin)).toEqual(['single-generation', 'composite'])
  })
})

describe('O3c: single generation follows the SELECTED tier; the composite stays fenced', () => {
  const OUT_1440 = { width: 2560, height: 1440 }

  it('copies a native-res 1440p raw channel at the 1440p step, composite fenced', () => {
    // The live defect: nativeres made the raw channel the monitor's size, so
    // the 1080p-constant equality never held and a 1440p step re-rendered
    // pixels a file on disk already had.
    const native = recording({
      composite: composite(),
      channels: [channel({ width: 2560, height: 1440 })],
    })
    const chosen = chooseCopySource(native, OUT_1440, { allowComposite: false })
    expect(chosen.source?.origin).toBe('single-generation')
    expect(chosen.source).toMatchObject({ width: 2560, height: 1440 })
  })

  it('with nothing matching, declines BOTH and each reason names real geometry', () => {
    const mismatched = recording({
      composite: composite(),
      channels: [channel({ width: 3840, height: 2160 })],
    })
    const chosen = chooseCopySource(mismatched, OUT_1440, { allowComposite: false })
    expect(chosen.source).toBeNull()
    const byOrigin = Object.fromEntries(chosen.declined.map((d) => [d.origin, d.reason]))
    expect(byOrigin['single-generation']).toContain('3840x2160')
    expect(byOrigin['composite']).toContain('1920x1080')
    expect(byOrigin['composite']).toContain('2560x1440')
  })

  it('a 1080p screen at the default step behaves exactly as before O3c', () => {
    const both = recording({ composite: composite() })
    const chosen = chooseCopySource(both, OUT, { allowComposite: true })
    expect(chosen.source?.origin).toBe('single-generation')
    expect(chosen.declined).toEqual([])
  })
})

describe('O3b may add a copyable case and may never remove one', () => {
  // The regression guard for the whole task: every take that could be
  // packet-copied before still can, byte for byte the same file.
  it('still copies a v1 MediaRecorder composite, and still calls it unspliceable', () => {
    const v1 = recording({
      composite: composite({ engine: 'v1' }),
      channels: [channel({ mimeType: 'video/webm;codecs=vp9' })],
    })
    const chosen = chooseCopySource(v1, OUT)
    expect(chosen.source?.origin).toBe('composite')
    // smart cut refuses on this, and the reason travels with the source rather
    // than being re-derived from CompositeRecording.engine at the call site.
    expect(chosen.source?.writer).toBe('mediarecorder')
  })

  it('still copies a composite whose take has two video channels', () => {
    const normal = recording({
      composite: composite(),
      channels: [channel(), channel({ id: 'ch_cam', kind: 'camera', blobKey: 'c.mp4' })],
    })
    expect(chooseCopySource(normal, OUT).source?.origin).toBe('composite')
  })

  it('carries the composite’s own clock through unchanged', () => {
    const both = recording({
      composite: composite({ startOffsetMs: 211 }),
      channels: [channel({ mimeType: 'video/webm;codecs=vp9' })],
    })
    expect(chooseCopySource(both, OUT).source?.startOffsetMs).toBe(211)
  })

  it('treats a composite with no declared origin as zero, like the old takes do', () => {
    const old = recording({
      composite: composite({ startOffsetMs: undefined }),
      channels: [channel({ mimeType: 'video/webm;codecs=vp9' })],
    })
    expect(chooseCopySource(old, OUT).source?.startOffsetMs).toBe(0)
  })

  it('refuses to copy an incomplete tail, whichever file it is', () => {
    const cut = recording({
      composite: composite({ tailIncomplete: true }),
      channels: [channel({ mimeType: 'video/webm;codecs=vp9' })],
    })
    // The source still resolves; the copy paths are what refuse it, with the
    // render as the fallback — unchanged from before O3b.
    expect(chooseCopySource(cut, OUT).source?.tailIncomplete).toBe(true)
  })
})
