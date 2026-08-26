import { describe, expect, it } from 'vitest'
import { loudnessFromCaptureEnvelope, loudnessFromCaptureStats } from './audio'
import type { CaptureLoudness, EditState, Recording } from '@core/types'

const WINDOW_MS = 100

/**
 * A take of two halves: SPEECH (7 loud windows in every 10, 3 pauses) and then
 * ROOM TONE. A cut keeping one half must move the percentiles — p90 falls 42 dB
 * when only the tone survives, p20 rises 8 dB when only the speech does — so a
 * function that averages, or that ignores the edit, cannot pass.
 *
 * The pauses matter: a fixture with no quiet windows at all is floor-bound and
 * every call would correctly refuse it, testing nothing.
 */
function envelopeOf(speechWindows: number, toneWindows: number, startMs = 0): CaptureLoudness {
  const n = speechWindows + toneWindows
  const rms = new Float32Array(n)
  const peak = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const speech = i < speechWindows
    const talking = speech && i % 10 < 7
    // A little spread inside each level so a percentile is not a single value.
    rms[i] = (talking ? 0.1 : speech ? 0.002 : 0.0008) * (1 + 0.01 * (i % 7))
    peak[i] = (talking ? 0.5 : speech ? 0.01 : 0.004) * (1 + 0.01 * (i % 5))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const sortedPeak = [...peak].sort((a, b) => a - b)
  return {
    channelIds: ['mic'],
    peak: Math.max(...peak),
    peakRobust: sortedPeak[Math.min(n - 1, Math.floor(0.99 * n))]!,
    loudRms: at(0.9),
    floorRms: at(0.2),
    frames: n * 4800,
    envelope: { windowRms: rms, windowPeak: peak, windowMs: WINDOW_MS, startMs },
  }
}

function recordingOf(durationMs: number): Recording {
  return {
    id: 'r',
    createdAt: 0,
    durationMs,
    channels: [
      {
        id: 'mic',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/mp4',
        blobKey: 'k',
        startOffsetMs: 0,
        durationMs,
      },
    ],
  }
}

function editOf(r: Recording, over: Partial<EditState> = {}): EditState {
  return {
    recordingId: r.id,
    globalTrimStartMs: 0,
    globalTrimEndMs: r.durationMs,
    channels: r.channels.map((c) => ({
      channelId: c.id,
      enabled: true,
      trimStartMs: 0,
      trimEndMs: c.durationMs,
    })),
    ...over,
  }
}

describe('X1 — an edited export re-percentiles the capture envelope instead of decoding again', () => {
  const stats = envelopeOf(200, 200) // 20 s loud + 20 s quiet
  const rec = recordingOf(40_000)

  it('over the whole take it agrees with the scalars capture stored', () => {
    const m = loudnessFromCaptureEnvelope(stats, rec, editOf(rec), ['mic'], 1)!
    const scalars = loudnessFromCaptureStats(stats, ['mic'], 1)!
    expect(m.loudRms).toBeCloseTo(scalars.loudRms, 6)
    expect(m.floorRms!).toBeCloseTo(scalars.floorRms!, 6)
    expect(m.peak).toBeCloseTo(scalars.peak, 6)
    expect(m.peakRobust!).toBeCloseTo(scalars.peakRobust!, 6)
  })

  it('cutting the room tone raises the floor to the speech half — it selects, it does not average', () => {
    const kept = loudnessFromCaptureEnvelope(
      stats,
      rec,
      editOf(rec, { segments: [{ startMs: 0, endMs: 20_000 }] }),
      ['mic'],
      1,
    )!
    const whole = loudnessFromCaptureEnvelope(stats, rec, editOf(rec), ['mic'], 1)!
    // p20 is now a speech PAUSE rather than the tone that is no longer there.
    expect(kept.floorRms).toBeGreaterThan(0.0019)
    expect(whole.floorRms).toBeLessThan(0.001)
    expect(kept.loudRms).toBeGreaterThan(0.09)
  })

  it('cutting the speech drops the loudness 40 dB to the tone that is left', () => {
    const kept = loudnessFromCaptureEnvelope(
      stats,
      rec,
      editOf(rec, { segments: [{ startMs: 20_000, endMs: 40_000 }] }),
      ['mic'],
      1,
    )!
    expect(kept.loudRms).toBeLessThan(0.001)
    expect(kept.peakRobust!).toBeLessThan(0.01)
  })

  it('two kept spans contribute both their window sets', () => {
    const m = loudnessFromCaptureEnvelope(
      stats,
      rec,
      editOf(rec, {
        segments: [
          { startMs: 0, endMs: 10_000 },
          { startMs: 30_000, endMs: 40_000 },
        ],
      }),
      ['mic'],
      1,
    )!
    // Half speech, half tone: p90 lands on speech, p20 on the tone.
    expect(m.loudRms).toBeGreaterThan(0.09)
    expect(m.floorRms).toBeLessThan(0.001)
  })

  it('scales by the mix gain exactly as the scalar shortcut does', () => {
    const a = loudnessFromCaptureEnvelope(stats, rec, editOf(rec), ['mic'], 1)!
    const b = loudnessFromCaptureEnvelope(stats, rec, editOf(rec), ['mic'], 0.5)!
    expect(b.loudRms).toBeCloseTo(a.loudRms * 0.5, 9)
    expect(b.peak).toBeCloseTo(a.peak * 0.5, 9)
  })

  it('a window the edit only partly keeps is out of the percentiles and in the peak', () => {
    // 3050 ms keeps windows 0-29 whole and straddles window 30, so this is also
    // the smallest selection that may answer at all.
    const m = loudnessFromCaptureEnvelope(
      stats,
      rec,
      editOf(rec, { segments: [{ startMs: 0, endMs: 3_050 }] }),
      ['mic'],
      1,
    )
    // 30 whole windows is exactly the minimum, so this must still answer.
    expect(m).not.toBeNull()
    expect(m!.peak).toBeGreaterThanOrEqual(m!.peakRobust!)
  })

  describe('falls back to the probe rather than describe a signal the file will not carry', () => {
    it('no envelope at all (a take recorded before X1)', () => {
      const old: CaptureLoudness = { ...stats }
      delete old.envelope
      expect(loudnessFromCaptureEnvelope(old, rec, editOf(rec), ['mic'], 1)).toBeNull()
    })

    it('no stats at all', () => {
      expect(loudnessFromCaptureEnvelope(undefined, rec, editOf(rec), ['mic'], 1)).toBeNull()
    })

    it('a channel the capture sum did not contain', () => {
      expect(loudnessFromCaptureEnvelope(stats, rec, editOf(rec), ['mic', 'sys'], 1)).toBeNull()
    })

    it('a per-channel trim — one contributor leaves part-way through a kept span', () => {
      const trimmed = editOf(rec)
      trimmed.channels[0]!.trimStartMs = 5_000
      expect(loudnessFromCaptureEnvelope(stats, rec, trimmed, ['mic'], 1)).toBeNull()
    })

    it('a sped span (F5b) — WSOLA retimes the material, so the windows reweight', () => {
      const sped = editOf(rec, { segments: [{ startMs: 0, endMs: 40_000, speed: 2 }] })
      expect(loudnessFromCaptureEnvelope(stats, rec, sped, ['mic'], 1)).toBeNull()
    })

    it('a selection too short to carry a percentile', () => {
      const tiny = editOf(rec, { segments: [{ startMs: 0, endMs: 1_000 }] })
      expect(loudnessFromCaptureEnvelope(stats, rec, tiny, ['mic'], 1)).toBeNull()
    })

    it('the codec-floor guard, which is the same guard the scalar shortcut takes', () => {
      // A quiet take: the makeup wants a boost, and the p20 floor bound is what
      // would decide it — capture measures PCM, the file is missing whatever the
      // codec dropped below its floor, so this one has to be decoded.
      // Speech at a level that wants a boost, over a floor high enough that the
      // p20 term is what would decide it.
      const nearFloor = envelopeOf(400, 0)
      nearFloor.envelope!.windowRms.fill(0.05)
      nearFloor.loudRms = 0.05
      nearFloor.floorRms = 0.05
      expect(loudnessFromCaptureEnvelope(nearFloor, rec, editOf(rec), ['mic'], 1)).toBeNull()
      expect(loudnessFromCaptureStats(nearFloor, ['mic'], 1)).toBeNull()
    })
  })

  it('reads the envelope at its own grid origin, not at recording zero', () => {
    // Audio that begins 250 ms after the earliest channel: window 0 is at 250 ms,
    // so a span starting at 20 s must land on the quiet half, not 2.5 windows off.
    const shifted = envelopeOf(200, 200, 250)
    const m = loudnessFromCaptureEnvelope(
      shifted,
      rec,
      editOf(rec, { segments: [{ startMs: 20_250, endMs: 40_250 }] }),
      ['mic'],
      1,
    )!
    expect(m.loudRms).toBeLessThan(0.001)
  })
})
