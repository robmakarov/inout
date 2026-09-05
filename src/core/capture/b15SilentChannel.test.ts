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
