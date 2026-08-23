import { describe, expect, it } from 'vitest'
import { drainRecorder, type DrainableRecorder } from './recorderDrain'

/**
 * A MediaRecorder stand-in whose backlog is known exactly. `queue` is what it
 * still owes; each requestData() hands over one entry.
 */
function fakeRecorder(queue: number[], opts: { throwAfter?: number } = {}) {
  let emitted = 0
  let probes = 0
  let state: RecordingState = 'recording'
  const recorder: DrainableRecorder = {
    get state() {
      return state
    },
    requestData() {
      probes++
      if (opts.throwAfter !== undefined && probes > opts.throwAfter) {
        state = 'inactive'
        throw new Error('recorder is inactive')
      }
      emitted += queue.shift() ?? 0
    },
  }
  return { recorder, emitted: () => emitted, probes: () => probes }
}

const noSleep = (): Promise<void> => Promise.resolve()

describe('drainRecorder', () => {
  it('keeps probing while bytes keep arriving, and stops once they do not', async () => {
    const f = fakeRecorder([100, 200, 0, 0])
    const stats = await drainRecorder(f.recorder, f.emitted, { sleep: noSleep })
    expect(stats.drainedBytes).toBe(300)
    expect(stats.timedOut).toBe(false)
    // Two empty answers in a row is the exit condition, so it must have asked
    // four times: the two that paid, and the two that proved it was done.
    expect(f.probes()).toBe(4)
  })

  it('does not touch a recorder that is not recording', async () => {
    const f = fakeRecorder([100])
    const stats = await drainRecorder(
      { get state() { return 'inactive' as RecordingState }, requestData: f.recorder.requestData },
      f.emitted,
      { sleep: noSleep },
    )
    expect(stats).toEqual({ drainMs: 0, drainedBytes: 0, timedOut: false })
    expect(f.probes()).toBe(0)
  })

  it('reports a timeout when the encoder never catches up', async () => {
    // A source that keeps producing: every probe pays, so the drain can only
    // ever end on the budget. This is the honest "the end of this take is
    // missing" case, and it must not be silent.
    const endless = { recorder: null as unknown as DrainableRecorder, bytes: 0 }
    let bytes = 0
    endless.recorder = {
      get state() {
        return 'recording' as RecordingState
      },
      requestData() {
        bytes += 10
      },
    }
    const stats = await drainRecorder(endless.recorder, () => bytes, {
      budgetMs: 30,
      pollMs: 1,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    expect(stats.timedOut).toBe(true)
    expect(stats.drainedBytes).toBeGreaterThan(0)
  })

  it('treats a recorder that stopped itself as drained, not as a timeout', async () => {
    // An ended stream makes Chrome stop the recorder; a self-stop FLUSHES, so
    // calling that a timeout would mark healthy takes as missing their end.
    const f = fakeRecorder([50, 50], { throwAfter: 1 })
    const stats = await drainRecorder(f.recorder, f.emitted, { sleep: noSleep })
    expect(stats.timedOut).toBe(false)
    expect(stats.drainedBytes).toBe(50)
  })
})
