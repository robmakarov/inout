import { describe, expect, it } from 'vitest'
import type { PaceSource, WorkPace } from '@core/types'
import { WORK_SLICE_MS, createPaceGate } from './paceGate'

/**
 * The brake itself. The POLICY is backgroundWork.ts's and is tested there;
 * what has to hold here is the mechanism: free at full speed, actually
 * sleeping below it, actually stopping at paused, and — the one this project
 * has already paid for once — reachable by a cancel.
 */

function source(): PaceSource & { set(level: WorkPace): void } {
  let level: WorkPace = 'full'
  const listeners = new Set<(l: WorkPace) => void>()
  return {
    level: () => level,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    set: (next) => {
      level = next
      for (const cb of listeners) cb(next)
    },
  }
}

const burn = (ms: number): void => {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    /* deliberate: the gate meters WALL CLOCK worked, not calls */
  }
}

describe('the background render brake', () => {
  it('costs a user-visible export nothing: at full speed wait() does not even yield', () => {
    const src = source()
    const gate = createPaceGate(src)
    expect(gate.wait()).toBeUndefined()
    expect(gate.restedMs()).toBe(0)
    gate.dispose()
  })

  it('rests after a slice of work, in proportion to the duty cycle', async () => {
    const src = source()
    const gate = createPaceGate(src)
    src.set('half')
    // Under one slice of work: nothing owed yet.
    await gate.wait()
    expect(gate.restedMs()).toBe(0)
    burn(WORK_SLICE_MS + 20)
    await gate.wait()
    // Half duty means it rests for about as long as it worked.
    expect(gate.restedMs()).toBeGreaterThanOrEqual(WORK_SLICE_MS * 0.5)
    gate.dispose()
  })

  it('a paused gate does not return until the pace comes back', async () => {
    const src = source()
    const gate = createPaceGate(src)
    src.set('paused')
    let returned = false
    const waiting = Promise.resolve(gate.wait()).then(() => {
      returned = true
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(returned).toBe(false)
    src.set('full')
    await waiting
    expect(returned).toBe(true)
    gate.dispose()
  })

  it('the ramp back wakes the job immediately rather than at the end of its nap', async () => {
    const src = source()
    const gate = createPaceGate(src)
    src.set('paused')
    const t0 = performance.now()
    const waiting = Promise.resolve(gate.wait())
    setTimeout(() => src.set('full'), 30)
    await waiting
    // The nap is 250 ms; woken by the change it must return far sooner.
    expect(performance.now() - t0).toBeLessThan(200)
    gate.dispose()
  })

  /**
   * THE PRECEDENT THIS PROJECT DOES NOT GET TO REPEAT: F16's first join wired
   * cancel to nothing and the render finished anyway. A gate that could not
   * see the abort would hold a cancelled job asleep inside its own nap.
   */
  it('a cancel reaches a paused job', async () => {
    const src = source()
    const abort = new AbortController()
    const gate = createPaceGate(src, { signal: abort.signal })
    src.set('paused')
    const waiting = Promise.resolve(gate.wait())
    abort.abort()
    await waiting
    gate.dispose()
  })

  it('gives up when it has been fully shed for longer than its pause budget', async () => {
    const src = source()
    let gaveUpAfter: number | null = null
    const gate = createPaceGate(src, {
      pauseBudgetMs: 120,
      onGiveUp: (ms) => {
        gaveUpAfter = ms
      },
    })
    src.set('paused')
    await expect(Promise.resolve(gate.wait())).rejects.toMatchObject({ name: 'AbortError' })
    expect(gaveUpAfter).not.toBeNull()
    gate.dispose()
  })
})
