/**
 * THE ORDER IS THE RULING — task M1's emergency floor.
 *
 * Every one of these is a claim about what a take gives up and when, so each is
 * checked as a mechanism rather than trusted to fall out of the numbers. The
 * one that matters most is the one that cannot be written: there is no rung for
 * audio, in any state, in either direction.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLOOR_FPS,
  RESOLUTION_FLOOR_LONG_EDGE,
  SACRIFICE_ORDER,
  atFullPlan,
  emergencyFloorEnabled,
  floorLongEdge,
  floorResolutionRungEnabled,
  nextRestore,
  nextSacrifice,
  setFloorResolutionRung,
  type FloorState,
} from './emergencyFloor'

const max60: FloorState = {
  cameraFps: 60,
  cameraRequestedFps: 60,
  screenFps: 60,
  screenRequestedFps: 60,
  screenLongEdge: 3024,
  screenRequestedLongEdge: 3024,
}

afterEach(() => {
  setFloorResolutionRung(null)
})

describe('the elastic system reaches max, and stops at the rate', () => {
  it('is ON by default — Robert 2026-09-03, "same elastic shit we have for everything else"', () => {
    expect(emergencyFloorEnabled()).toBe(true)
  })

  it('and the SIZE is still not a dial: the rung is off, as everywhere else', () => {
    expect(floorResolutionRungEnabled()).toBe(false)
    // With the rung off the order ends at the rate rungs and says so.
    const spentRates: FloorState = { ...max60, cameraFps: FLOOR_FPS, screenFps: FLOOR_FPS }
    expect(nextSacrifice(spentRates)).toBeNull()
  })

  it('but a size already given up is ALWAYS taken back, flag or not', () => {
    // Capacity knowledge may shape a take UP, never down: a flag flipped
    // mid-take must not strand a take at three quarters of its picture.
    const stepped: FloorState = { ...max60, screenLongEdge: 1920 }
    expect(floorResolutionRungEnabled()).toBe(false)
    expect(nextRestore(stepped)).toBe('resolution')
  })
})

describe('the sacrifice order', () => {
  it('spends the camera first, then the screen rate, then resolution', () => {
    setFloorResolutionRung(true)
    const order: string[] = []
    let s = { ...max60 }
    for (let i = 0; i < 4; i++) {
      const rung = nextSacrifice(s)
      if (!rung) break
      order.push(rung)
      if (rung === 'camera-fps') s = { ...s, cameraFps: FLOOR_FPS }
      else if (rung === 'screen-fps') s = { ...s, screenFps: FLOOR_FPS }
      else s = { ...s, screenLongEdge: floorLongEdge(s.screenLongEdge ?? 0) }
    }
    expect(order).toEqual(['camera-fps', 'screen-fps', 'resolution'])
    expect(order).toEqual([...SACRIFICE_ORDER])
    // AND THE LIST ENDS THERE. A second resolution step would be a second
    // segment seam on a take that has already proved it cannot carry its plan.
    expect(nextSacrifice(s)).toBeNull()
  })

  it('skips the camera when there is none — a screen-only max take', () => {
    expect(nextSacrifice({ ...max60, cameraFps: null, cameraRequestedFps: null })).toBe('screen-fps')
  })

  it('has nothing left to give at the bottom, and says so', () => {
    const spent: FloorState = {
      cameraFps: FLOOR_FPS,
      cameraRequestedFps: 60,
      screenFps: FLOOR_FPS,
      screenRequestedFps: 60,
      screenLongEdge: RESOLUTION_FLOOR_LONG_EDGE,
      screenRequestedLongEdge: 3024,
    }
    expect(nextSacrifice(spent)).toBeNull()
  })

  it('never names audio, in any state', () => {
    const states: FloorState[] = [
      max60,
      { ...max60, cameraFps: 30 },
      { ...max60, cameraFps: 30, screenFps: 30 },
      { ...max60, cameraFps: null, cameraRequestedFps: null, screenFps: 30 },
    ]
    for (const s of states) {
      expect(nextSacrifice(s)).not.toBe('audio')
      expect(nextRestore(s)).not.toBe('audio')
    }
    expect(SACRIFICE_ORDER).not.toContain('audio')
  })
})

describe('recovery is the same list backwards', () => {
  it('gives back resolution first, then the screen rate, then the camera', () => {
    let s: FloorState = {
      cameraFps: 30,
      cameraRequestedFps: 60,
      screenFps: 30,
      screenRequestedFps: 60,
      screenLongEdge: 2268,
      screenRequestedLongEdge: 3024,
    }
    const order: string[] = []
    for (let i = 0; i < 4; i++) {
      const rung = nextRestore(s)
      if (!rung) break
      order.push(rung)
      if (rung === 'resolution') s = { ...s, screenLongEdge: s.screenRequestedLongEdge }
      else if (rung === 'screen-fps') s = { ...s, screenFps: s.screenRequestedFps }
      else s = { ...s, cameraFps: s.cameraRequestedFps }
    }
    expect(order).toEqual(['resolution', 'screen-fps', 'camera-fps'])
    expect(atFullPlan(s)).toBe(true)
  })

  it('has nothing to restore on a take that never gave anything up', () => {
    expect(nextRestore(max60)).toBeNull()
    expect(atFullPlan(max60)).toBe(true)
  })
})

describe('the resolution rung', () => {
  it('is one step, even on both sides, and never below the floor', () => {
    expect(floorLongEdge(3024)).toBe(2268)
    expect(floorLongEdge(1920)).toBe(1440)
    // 1706 would round to an odd side; the step is evened DOWN because AVC
    // refuses an odd one rather than rounding it.
    expect(floorLongEdge(2276)! % 2).toBe(0)
    // below the floor the rung simply does not exist
    expect(floorLongEdge(RESOLUTION_FLOOR_LONG_EDGE)).toBeNull()
    expect(floorLongEdge(1600)).toBeNull()
  })
})
