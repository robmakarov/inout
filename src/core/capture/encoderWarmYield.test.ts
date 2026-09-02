import { beforeEach, describe, expect, it } from 'vitest'
import {
  encoderWarmYielded,
  releaseEncoderWarmYield,
  yieldEncoderWarmToTake,
} from './encoderWarmYield'

/**
 * H6 — the one bit of state between the warm and the take.
 *
 * It has to be settable SYNCHRONOUSLY at the record press (session.arm does it
 * before its first await) and it has to be given back, or the encoder
 * measurement the warm stood down for is owed forever.
 */
describe('the warm standing down for a take', () => {
  beforeEach(() => releaseEncoderWarmYield())

  it('starts released — nothing is recording at app load', () => {
    expect(encoderWarmYielded()).toBe(false)
  })

  it('is set the moment a take commits, and is idempotent', () => {
    yieldEncoderWarmToTake()
    yieldEncoderWarmToTake()
    expect(encoderWarmYielded()).toBe(true)
  })

  it('is given back when the take ends — a cancelled take too', () => {
    yieldEncoderWarmToTake()
    releaseEncoderWarmYield()
    expect(encoderWarmYielded()).toBe(false)
  })
})
