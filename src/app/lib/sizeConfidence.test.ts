import { describe, expect, it } from 'vitest'
import { sizeConfidence, sizeNotice, type SizeConfidence } from './sizeConfidence'

describe('sizeConfidence', () => {
  it('the default step is exact whatever the probe is doing', () => {
    for (const probe of ['running', 'measured', 'unavailable'] as const) {
      expect(sizeConfidence({ exact: true, measured: false, probe })).toBe('exact')
    }
  })

  it('a priced step is measured', () => {
    expect(sizeConfidence({ exact: false, measured: true, probe: 'measured' })).toBe('measured')
  })

  it('the model is provisional while the probe is still running', () => {
    expect(sizeConfidence({ exact: false, measured: false, probe: 'running' })).toBe('provisional')
  })

  /**
   * THE BUG F7d NAMES. A probe that cannot run used to leave the panel in the
   * same state as a probe that is still working, so an audio-only take (no
   * video channel to compose) sat on "they settle in a few seconds" forever.
   */
  it('the model is ROUGH, not provisional, once the probe is known not to be coming', () => {
    expect(sizeConfidence({ exact: false, measured: false, probe: 'unavailable' })).toBe('rough')
  })

  it('a probe that finished without pricing THIS step still leaves it rough', () => {
    // calibrateSteps can return a calibration whose lanes failed for one tier.
    expect(sizeConfidence({ exact: false, measured: false, probe: 'measured' })).toBe('rough')
  })
})

describe('sizeNotice', () => {
  const set = (...c: SizeConfidence[]): SizeConfidence[] => c

  it('says nothing when every number stands on its own', () => {
    expect(sizeNotice(set('exact', 'measured', 'measured'))).toBeNull()
  })

  it('promises a correction only while one is coming', () => {
    expect(sizeNotice(set('exact', 'provisional', 'measured'))).toBe('measuring')
  })

  it('admits the guess when no correction is coming', () => {
    expect(sizeNotice(set('exact', 'rough', 'rough'))).toBe('rough')
  })

  it('a still-running probe wins over an already-failed step — the panel is about to change', () => {
    expect(sizeNotice(set('exact', 'provisional', 'rough'))).toBe('measuring')
  })
})
