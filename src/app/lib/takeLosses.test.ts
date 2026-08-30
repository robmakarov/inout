import { describe, expect, it } from 'vitest'
import { takeLosses } from './channels'
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
  })

  it('names the mute when the source muted itself', () => {
    const [loss] = takeLosses(
      [ch({ diagnostics: { silentTailMs: 30_000, events: [{ atMs: 71_000, type: 'mute' }] } })],
      caps,
    )
    expect(loss?.message).toContain('the source muted itself')
  })

  it('a tap that was rebuilt and RECOVERED still says so — there may be a gap', () => {
    const [loss] = takeLosses([ch({ diagnostics: { silentTailMs: 0, revivals: 1 } })], caps)
    expect(loss?.message).toContain('came back on its own')
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
