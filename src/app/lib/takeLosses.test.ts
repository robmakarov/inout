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
    expect(loss?.message).toContain('went silent 60s before the end')
    expect(loss?.message).toContain('from 60s')
    expect(loss?.message).toContain('2 attempts')
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
    expect(loss?.message).toContain('reopened 1 time')
  })

  it('a quiet ending is not a dead source', () => {
    // Someone stops talking two seconds before pressing stop.
    expect(takeLosses([ch({ diagnostics: { silentTailMs: 2_000 } })], caps)).toEqual([])
  })

  it('reports padding only when a listener could notice it', () => {
    expect(takeLosses([ch({ diagnostics: { paddedMs: 40 } })], caps)).toEqual([])
    const [loss] = takeLosses([ch({ diagnostics: { paddedMs: 1_400 } })], caps)
    expect(loss?.message).toContain('1.4s')
  })

  it('video channels are not audio and are left alone', () => {
    expect(
      takeLosses([{ kind: 'screen', media: 'video', durationMs: 1000, diagnostics: { silentTailMs: 99_000 } }], caps),
    ).toEqual([])
  })
})
