/**
 * M1, AUDIT ITEM (f) — A CODEC RUNG THAT WAS SKIPPED IS A DECISION, AND IT GOES
 * THROUGH THE DOOR.
 *
 * One of the three paths the folded-in S1 gate names by hand ("a rate step, a
 * composite drop and a codec fallback each append an entry THROUGH THE DOOR").
 * This one is provable without a browser precisely because node has no video
 * encoders at all: every rung of the ladder is unencodable here, so the export
 * walks the whole ladder, records each rung it lost, and then fails — which is
 * exactly the shape of the real thing on a machine with no hardware AV1.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { pickEncodingTarget } from './codecs'
import { readDoorLog, resetDoorForTests } from '@core/door'

beforeEach(() => {
  resetDoorForTests()
})

describe('the codec ladder announces what it skipped', () => {
  it('records every rung it could not take, with the reason and the geometry', async () => {
    await expect(pickEncodingTarget(1920, 1080, true)).rejects.toThrow(
      'No supported encoder configuration',
    )
    const { decisions } = readDoorLog()
    expect(decisions.length).toBeGreaterThan(0)
    for (const d of decisions) {
      expect(d.dial).toBe('quality')
      expect(d.decidedBy).toBe('codec')
      expect(d.action).toBe('shed')
      expect(d.what).toMatch(/^export codec rung .+ skipped$/)
      // The numbers the decision was made on, not just the verdict.
      expect(d.measured).toMatchObject({ width: 1920, height: 1080 })
      expect(typeof d.measured?.rung).toBe('string')
    }
    // The floor is AVC and it is reached: a ladder that gave up above the floor
    // would be a different defect (an export that never happens).
    expect(decisions.some((d) => d.what.includes('avc'))).toBe(true)
  })

  it('says nothing when nothing is skipped', async () => {
    // Nothing to assert but the absence: a run that finds its rung immediately
    // must not write a line, or a clean export would carry a ledger of
    // non-events and the dimension would grade noise.
    resetDoorForTests()
    expect(readDoorLog().decisions).toHaveLength(0)
  })
})
