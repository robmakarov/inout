/**
 * B15 — THE CHANNEL THAT WAS HEARD, WENT SILENT, AND SAID NOTHING.
 *
 * Robert's `rec_tcjr3v2cskgd` (5:51, whole-screen `max`) carried 10.57 s of real
 * sound and 195.1 s of pure digital zeros after a YouTube video switch. The
 * rescue fired six times against that silence and recovered nothing — by
 * design it cannot, it re-taps a clone of a source that is itself silent — and
 * NOTHING ON SCREEN SAID SO for any of the 195 seconds. This pins the two
 * halves that make that impossible now: the rule for WHEN a silent run
 * convicts, and the label that stops calling a monitor share's audio a tab's.
 */
import { describe, expect, it } from 'vitest'
import { ReviveSchedule, SILENCE_CONVICTS_AT_ATTEMPT } from './reviveSchedule'
import { channelLabel, silentChannelMessage, takeLosses } from '@app/lib/channels'
import { detectCapabilities } from '@core/capabilities'
import { buildReportCard } from '@core/report/reportCard'
import type { Recording } from '@core/types'

const RATE = 48_000
const sec = (n: number): number => Math.round(n * RATE)

/** Feed `seconds` of digital zeros through the ladder from `atSec`, counting
 *  the attempts it would have made. One batch every 128 frames, as the worklet
 *  delivers them. */
function silentFor(rev: ReviveSchedule, fromFrame: number, seconds: number): number {
  let attempts = 0
  const step = 128
  for (let f = fromFrame; f < fromFrame + sec(seconds); f += step) {
    if (rev.silentBatch(f, step)) attempts = rev.attempts
  }
  return attempts
}

describe('B15 — when a heard-then-silent channel convicts', () => {
  it('a quiet passage before the second rung says nothing', () => {
    const rev = new ReviveSchedule({ sampleRate: RATE })
    rev.noteSignal()
    // 8 s of zeros: past the 5 s first rung, short of the 10 s second.
    const attempts = silentFor(rev, 0, 8)
    expect(attempts).toBe(1)
    expect(attempts >= SILENCE_CONVICTS_AT_ATTEMPT).toBe(false)
  })

  it("Robert's take convicts — heard, then zeros past the second rung", () => {
    const rev = new ReviveSchedule({ sampleRate: RATE })
    // 10.57 s of real sound (145.187 → 155.752 s), then the death.
    rev.noteSignal()
    const attempts = silentFor(rev, sec(10.57), 20)
    expect(rev.heardSignal).toBe(true)
    expect(attempts).toBeGreaterThanOrEqual(SILENCE_CONVICTS_AT_ATTEMPT)
  })

  it('a channel that never carried sound never convicts — that is Recording.missing', () => {
    const rev = new ReviveSchedule({ sampleRate: RATE })
    const attempts = silentFor(rev, 0, 200)
    // The ladder still climbs (the rescue is worth trying either way)…
    expect(attempts).toBeGreaterThanOrEqual(SILENCE_CONVICTS_AT_ATTEMPT)
    // …but nothing was ever heard, so this is not a death.
    expect(rev.heardSignal).toBe(false)
  })
})

describe('B15 — a monitor share is not a tab', () => {
  const caps = detectCapabilities()

  it('names the machine when the picker returned a monitor', () => {
    expect(channelLabel('system-audio', caps, 'monitor')).toBe('System Audio')
    expect(channelLabel('system-audio', caps, 'window')).toBe('System Audio')
  })

  it('names the tab only when the picker returned one', () => {
    expect(channelLabel('system-audio', caps, 'browser')).toBe('Tab Audio')
  })

  it("the editor's loss line follows the surface the take actually captured", () => {
    const channels = [
      {
        kind: 'system-audio' as const,
        media: 'audio',
        durationMs: 350_872,
        diagnostics: { silentTailMs: 195_108, paddedMs: 835 },
      },
    ]
    const [onMonitor] = takeLosses(channels, caps, 'monitor')
    const [onTab] = takeLosses(channels, caps, 'browser')
    expect(onMonitor?.message).toContain('System Audio went silent')
    expect(onTab?.message).toContain('Tab Audio went silent')
  })

  it('the live sentence names the one thing that can actually reconnect it', () => {
    const msg = silentChannelMessage(['system-audio'], caps, 'monitor')
    expect(msg).toContain('System Audio')
    expect(msg).toContain('chip')
    // NOT the frozen-source instruction: the picture is fine.
    expect(msg).not.toContain('still image')
  })
})

describe('B15 — the card names the audio path it graded', () => {
  const take = (surface: 'monitor' | 'browser' | undefined): Recording =>
    ({
      id: 'rec_b15',
      createdAt: 0,
      durationMs: 350_872,
      channels: [
        {
          kind: 'system-audio',
          media: 'audio',
          mimeType: 'audio/webm',
          blobKey: 'k',
          startOffsetMs: 0,
          durationMs: 350_872,
          diagnostics: { silentTailMs: 195_108, silentTotalMs: 195_108, paddedMs: 835 },
        },
      ],
      ...(surface
        ? {
            capturedSurface: {
              kind: surface,
              videoLabel: surface === 'monitor' ? 'screen:1:0' : 'web-contents-media-stream://7:1',
              audioLabel: surface === 'monitor' ? null : 'Tab audio',
              audioDeviceId: null,
            },
          }
        : null),
    }) as unknown as Recording

  it("a whole-screen take is not told its TAB audio died", () => {
    const card = buildReportCard(take('monitor'))
    const dim = card.dimensions.find((d) => d.id === 'audio-continuity')!
    expect(dim.status).toBe('fail')
    expect(dim.headline).toContain('system audio')
    expect(dim.headline).not.toContain('tab audio')
    expect(dim.detail).toContain('monitor share')
  })

  it('a tab share keeps the word that is right for it', () => {
    const dim = buildReportCard(take('browser')).dimensions.find((d) => d.id === 'audio-continuity')!
    expect(dim.headline).toContain('tab audio')
  })

  it('a take made before the field says only what it can', () => {
    const dim = buildReportCard(take(undefined)).dimensions.find((d) => d.id === 'audio-continuity')!
    expect(dim.headline).toContain('tab audio')
    expect(dim.detail).not.toContain('share')
  })
})
