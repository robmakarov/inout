import { describe, expect, it } from 'vitest'
import type { CaptureConfig, Recording } from '@core/types'
import { plannedBytesPerSec } from '@core/capture/captureBitrate'
import { measuredBytesPerSec, predictBytesPerSec, takeBytesPerSec } from './diskPreflight'

/**
 * B5: the rate has to come from THIS machine, because the only alternative is
 * guessing how compressible the content is — the guess that made the export
 * size panel wrong by 2.15x (B1). The takes it already made are the evidence.
 */
const MB = 1048576

const take = (over: Partial<Recording> & { bytes?: number }): Recording => ({
  id: over.id ?? 'r',
  createdAt: over.createdAt ?? 0,
  durationMs: over.durationMs ?? 60_000,
  qualityStep: over.qualityStep,
  channels: [
    {
      id: 'c',
      kind: 'screen',
      media: 'video',
      mimeType: 'video/mp4',
      blobKey: 'b',
      startOffsetMs: 0,
      durationMs: over.durationMs ?? 60_000,
      bytes: over.bytes ?? 100 * MB,
    },
  ],
})

const config: CaptureConfig = { screen: true, camera: false, mic: true, systemAudio: false }

describe('what a second of the next take will cost', () => {
  it('reads a take’s own byte rate, channels plus the composite beside them', () => {
    const t = take({ bytes: 60 * MB, durationMs: 60_000 })
    t.composite = { blobKey: 'k', mimeType: 'video/mp4', durationMs: 60_000, width: 1920, height: 1080, bytes: 60 * MB }
    expect(takeBytesPerSec(t)).toBeCloseTo(2 * MB, -3)
  })

  it('refuses a take too short to judge — that is the encoder waking up', () => {
    expect(takeBytesPerSec(take({ durationMs: 4_000 }))).toBeNull()
  })

  it('refuses a take that never recorded its size (recorded before we kept it)', () => {
    const t = take({})
    delete t.channels[0].bytes
    expect(takeBytesPerSec(t)).toBeNull()
  })

  it('takes the MEDIAN, so one 60 fps game tab does not set the rate forever', () => {
    const takes = [
      take({ id: 'a', createdAt: 5, bytes: 100 * MB, qualityStep: 'max' }),
      take({ id: 'b', createdAt: 4, bytes: 110 * MB, qualityStep: 'max' }),
      take({ id: 'c', createdAt: 3, bytes: 900 * MB, qualityStep: 'max' }),
    ]
    expect(measuredBytesPerSec(takes, 'max')).toBeCloseTo((110 * MB) / 60, -2)
  })

  it('only reads takes recorded at the same step — 540p says nothing about max', () => {
    const takes = [take({ id: 'a', createdAt: 5, bytes: 30 * MB, qualityStep: '540p' })]
    expect(measuredBytesPerSec(takes, 'max')).toBeNull()
    expect(measuredBytesPerSec(takes, '540p')).toBeCloseTo((30 * MB) / 60, -2)
  })

  it('reads only the most recent few, so the answer follows what is recorded now', () => {
    const old = Array.from({ length: 8 }, (_, i) =>
      take({ id: `o${i}`, createdAt: i, bytes: 600 * MB, qualityStep: 'max' }),
    )
    const recent = Array.from({ length: 5 }, (_, i) =>
      take({ id: `n${i}`, createdAt: 100 + i, bytes: 60 * MB, qualityStep: 'max' }),
    )
    expect(measuredBytesPerSec([...old, ...recent], 'max')).toBeCloseTo((60 * MB) / 60, -2)
  })

  it('falls back to the configured bitrates on a profile with no history, and says so', () => {
    const p = predictBytesPerSec([], 'max', config)
    expect(p.source).toBe('planned')
    expect(p.takesRead).toBe(0)
    // screen 8 Mbps + mic 128 kbps + composite 8 Mbps + its audio 128 kbps.
    expect(p.bytesPerSec).toBeCloseTo((8_000_000 + 128_000 + 8_000_000 + 128_000) / 8, -2)
  })

  it('prefers what the machine measured over what the encoder was asked for', () => {
    const takes = [take({ id: 'a', createdAt: 1, bytes: 12 * MB, qualityStep: 'max' })]
    const p = predictBytesPerSec(takes, 'max', config)
    expect(p.source).toBe('measured')
    expect(p.takesRead).toBe(1)
    expect(p.bytesPerSec).toBeCloseTo((12 * MB) / 60, -2)
  })

  it('the single-generation path plans no composite, because it writes none', () => {
    const both = plannedBytesPerSec({ ...config, composite: true })
    const one = plannedBytesPerSec({ ...config, composite: false })
    expect(one).toBeLessThan(both)
    expect(both - one).toBeCloseTo((8_000_000 + 128_000) / 8, -2)
  })

  it('a camera beside a screen is priced as the PiP it will be (O11c)', () => {
    const withCam = plannedBytesPerSec({ screen: true, camera: true, mic: false, systemAudio: false })
    const noCam = plannedBytesPerSec({ screen: true, camera: false, mic: false, systemAudio: false })
    expect(withCam - noCam).toBeCloseTo(2_500_000 / 8, -2)
  })
})
