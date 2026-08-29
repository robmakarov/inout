import { describe, expect, it } from 'vitest'
import type { ArmingStep, ArmingTimelineEntry } from '@core/capture'
import { armingLabel, foldWaiting } from './arming'

const ev = (
  step: ArmingStep,
  status: ArmingTimelineEntry['status'],
): ArmingTimelineEntry => ({ step, status, tMs: 0 })

const run = (events: ArmingTimelineEntry[]): ArmingStep[] =>
  events.reduce<ArmingStep[]>((acc, e) => foldWaiting(acc, e), [])

describe('arming label tracks what is outstanding, not what started last', () => {
  it('names the one device still missing', () => {
    // The exact shape of Robert report: three devices start together, two land,
    // the screen picker is still open. The old label said "microphone" here
    // purely because mic was the last 'start' it saw.
    const waiting = run([
      ev('camera', 'start'),
      ev('mic', 'start'),
      ev('display', 'start'),
      ev('camera', 'done'),
      ev('mic', 'done'),
    ])
    expect(waiting).toEqual(['display'])
    expect(armingLabel(waiting)).toBe('Waiting for screen…')
  })

  it('goes quiet once every device has landed', () => {
    const waiting = run([
      ev('mic', 'start'),
      ev('display', 'start'),
      ev('display', 'done'),
      ev('mic', 'done'),
    ])
    expect(waiting).toEqual([])
    expect(armingLabel(waiting)).toBeNull()
  })

  it('a device that fails, times out or is skipped stops being waited on', () => {
    for (const status of ['failed', 'timeout', 'skipped'] as const) {
      const waiting = run([ev('mic', 'start'), ev('display', 'start'), ev('mic', status)])
      expect(waiting).toEqual(['display'])
      expect(armingLabel(waiting)).toBe('Waiting for screen…')
    }
  })

  it('lists several outstanding devices rather than picking one', () => {
    const waiting = run([ev('display', 'start'), ev('mic', 'start'), ev('camera', 'start')])
    expect(armingLabel(waiting)).toBe('Waiting for screen, microphone and camera…')
  })

  it('keeps start order so the line does not reshuffle as devices land', () => {
    const waiting = run([
      ev('camera', 'start'),
      ev('mic', 'start'),
      ev('display', 'start'),
      ev('mic', 'done'),
    ])
    expect(waiting).toEqual(['camera', 'display'])
  })

  it('is idempotent on a repeated start', () => {
    expect(run([ev('mic', 'start'), ev('mic', 'start')])).toEqual(['mic'])
  })

  it('ignores a completion for a step that never started', () => {
    expect(run([ev('mic', 'start'), ev('camera', 'done')])).toEqual(['mic'])
  })
})
