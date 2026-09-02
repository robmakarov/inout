import { describe, expect, it } from 'vitest'
import { containedChannelMessage, seamMessages, takeLosses } from './channels'
import { detectCapabilities } from '@core/capabilities'

/**
 * Robert, 2026-08-30: "tab audio died completly". The take KNEW — every audio
 * channel carries silentTailMs, revivals and its track's life events, stored on
 * the recording precisely because "the console dies with the tab" — and nothing
 * showed it. He found out by listening.
 */
const caps = detectCapabilities()
const ch = (over: Record<string, unknown> = {}) => ({
  kind: 'system-audio' as const,
  media: 'audio',
  durationMs: 120_000,
  ...over,
})

describe('what a take says it lost', () => {
  it('a healthy take says nothing', () => {
    expect(takeLosses([ch({ diagnostics: { silentTailMs: 0, paddedMs: 0 } })], caps)).toEqual([])
    expect(takeLosses([ch()], caps)).toEqual([])
  })

  it("HIS CASE: audio that died a minute in and never came back", () => {
    const [loss] = takeLosses(
      [ch({ durationMs: 120_000, diagnostics: { silentTailMs: 60_000, revivals: 2 } })],
      caps,
    )
    expect(loss?.message).toContain('went silent 60s in and never came back')
    expect(loss?.message).toContain('last 60s have no sound')
    // Attempts from an EARLIER quiet stretch are not evidence about this one.
    expect(loss?.message).not.toContain('attempt')
  })

  it('SAYS NOTHING about a person reaching for the stop button', () => {
    // Robert's 240 s take reported "went silent 234s in ... 4 attempts to
    // reopen it did not take". Six seconds is 2.5 % of it, the sound was fine,
    // and four attempts need 75 s of continuous silence — they belonged to a
    // different, earlier stretch and were glued on.
    expect(takeLosses([ch({ durationMs: 240_000, diagnostics: { silentTailMs: 6_000, revivals: 4 } })], caps)).toEqual([])
  })

  it('a long tail that is still a small share of a long take says nothing', () => {
    // 12 s of quiet at the end of a 30-minute take is someone finishing up.
    expect(takeLosses([ch({ durationMs: 1_800_000, diagnostics: { silentTailMs: 12_000 } })], caps)).toEqual([])
  })

  it('names the mute when the source muted itself', () => {
    const [loss] = takeLosses(
      [ch({ diagnostics: { silentTailMs: 30_000, events: [{ atMs: 71_000, type: 'mute' }] } })],
      caps,
    )
    expect(loss?.message).toContain('the source muted itself')
  })

  it('A RESCUE THAT WORKED IS NOT NEWS — the sound is there, so nothing is said', () => {
    // Tab audio is legitimately silent much of the time, so the capture-side
    // rescue fires on healthy takes. Reporting every one of those trained the
    // user to distrust the banner, which is worse than saying nothing.
    expect(takeLosses([ch({ diagnostics: { silentTailMs: 0, revivals: 1 } })], caps)).toEqual([])
    expect(takeLosses([ch({ diagnostics: { silentTailMs: 0, revivals: 6 } })], caps)).toEqual([])
  })

  it('a quiet ending is not a dead source', () => {
    // Someone stops talking two seconds before pressing stop.
    expect(takeLosses([ch({ diagnostics: { silentTailMs: 2_000 } })], caps)).toEqual([])
  })

  it('DOES NOT CALL SYNC PADDING A LOSS — Robert: "so its laying"', () => {
    // Both channels had recorded perfectly and the banner said "Mic lost 0.4s".
    // A few hundred ms of inserted silence across a take is the wall-clock hold
    // working; nothing was lost and nothing is audible.
    expect(takeLosses([ch({ diagnostics: { paddedMs: 400 } })], caps)).toEqual([])
    expect(takeLosses([ch({ diagnostics: { paddedMs: 600 } })], caps)).toEqual([])
    expect(takeLosses([ch({ diagnostics: { paddedMs: 1_900 } })], caps)).toEqual([])
    const [loss] = takeLosses([ch({ diagnostics: { paddedMs: 4_200 } })], caps)
    expect(loss?.message).toContain('4.2s')
    expect(loss?.message).toContain('nothing is missing')
  })

  it('video channels are not audio and are left alone', () => {
    expect(
      takeLosses([{ kind: 'screen', media: 'video', durationMs: 1000, diagnostics: { silentTailMs: 99_000 } }], caps),
    ).toEqual([])
  })
})

/**
 * H1 — THE TWO SENTENCES A CONTAINED COMPONENT DEATH GETS.
 *
 * Wording is Robert's on H4's precedent; what is pinned here is what the
 * sentences must NOT say. Neither may tell the user the channel is over or
 * hand them an instruction: the device is live, the take is recording, and the
 * only true statement is that a fraction of a second is gone.
 */
describe('H1 — contained component death', () => {
  it('says the channel restarted itself and is STILL recording', () => {
    const m = containedChannelMessage(['camera'], caps)
    expect(m).toContain('Camera')
    expect(m).toContain('restarted itself')
    expect(m).toContain('still recording')
    // The dead-channel sentence's instruction would be wrong here.
    expect(m).not.toContain('Check the lid')
  })

  it('folds several kinds into one line', () => {
    expect(containedChannelMessage(['camera', 'mic'], caps)).toContain('were interrupted')
  })

  it('after the take, names the instant and the hole', () => {
    const [line] = seamMessages(
      [{ kind: 'screen', atMs: 66_000, gapMs: 62, cause: 'encoder-error' }],
      caps,
    )
    expect(line.message).toContain('1:06')
    expect(line.message).toContain('62 ms')
    expect(line.message).toContain('the rest of the take is there')
  })

  it('one line per seam — a channel contained twice says so twice', () => {
    expect(
      seamMessages(
        [
          { kind: 'screen', atMs: 6_000, gapMs: 60, cause: 'encoder-error' },
          { kind: 'screen', atMs: 40_000, gapMs: 71, cause: 'worker-death' },
        ],
        caps,
      ),
    ).toHaveLength(2)
  })
})
