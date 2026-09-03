/**
 * THE FLOOR, END TO END IN ONE THREAD — task M1.
 *
 * The rig proves it in the product; this proves the ORDER is a mechanism and
 * not an emergent property of where the bands happen to sit. Everything here is
 * the real thing: the real detector (core/pressure.ts), the real ladder rules
 * (captureLadder.ts), the real broker (core/backgroundWork.ts) and the real
 * sacrifice order (emergencyFloor.ts). Only the signals are synthetic, and they
 * are the same shape the raw worker's sampler posts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FloorController } from './floorController'
import { FLOOR_FPS, floorLongEdge, type FloorState } from './emergencyFloor'
import { WARMUP_MS, SETTLE_MS } from './captureLadder'
import { currentPace, noteTakeActive } from '../backgroundWork'
import type { PressureSignals } from '../pressure'

/** A window in which everything is fine: frames in, nothing dropped, an idle
 *  queue, a punctual worker. */
function calm(): PressureSignals {
  return {
    intervalMs: 256,
    frameBudgetMs: 1000 / 60,
    queueMean: 0.2,
    queueCliff: 6,
    encodeLatencyMs: 8,
    workerLateMaxMs: 2,
    workerLateMeanMs: 1,
    perFrameCostMs: 6,
    gpuPerFrameMs: null,
    stale: 0,
    arrivals: 15,
    dropped: 0,
    burst: 0,
    platform: null,
  }
}

/** A window in which the encoder has started refusing frames — pressure.ts's
 *  loss floor makes this `critical` on the take's OWN work by itself. */
function starving(): PressureSignals {
  return { ...calm(), queueMean: 5.5, encodeLatencyMs: 90, perFrameCostMs: 40, arrivals: 15, dropped: 4 }
}

const max60: FloorState = {
  cameraFps: 60,
  cameraRequestedFps: 60,
  screenFps: 60,
  screenRequestedFps: 60,
  screenLongEdge: 3024,
  screenRequestedLongEdge: 3024,
}

beforeEach(() => {
  noteTakeActive(true)
})
afterEach(() => {
  noteTakeActive(false)
})

/** Run the controller forward, applying whatever it asks for, and return the
 *  order it asked in. */
function run(
  c: FloorController,
  from: number,
  to: number,
  signals: () => PressureSignals,
  state: FloorState,
): { order: string[]; state: FloorState } {
  const order: string[] = []
  let s = { ...state }
  for (let t = from; t <= to; t += 256) {
    const tick = c.tick(t, signals(), s)
    if (!tick.action) continue
    order.push(`${tick.action.direction}:${tick.action.rung}`)
    const { rung, direction } = tick.action
    if (rung === 'camera-fps') s = { ...s, cameraFps: direction === 'down' ? FLOOR_FPS : s.cameraRequestedFps }
    else if (rung === 'screen-fps') s = { ...s, screenFps: direction === 'down' ? FLOOR_FPS : s.screenRequestedFps }
    else {
      s = {
        ...s,
        screenLongEdge:
          direction === 'down' ? floorLongEdge(s.screenLongEdge ?? 0) : s.screenRequestedLongEdge,
      }
    }
    c.noteApplied(t, direction)
  }
  return { order, state: s }
}

describe('nothing engages on a take that is coping', () => {
  it('takes no rung at all across a calm minute', () => {
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    const { order, state } = run(c, 0, 60_000, calm, max60)
    expect(order).toEqual([])
    expect(state).toEqual(max60)
  })

  it('takes no rung during the encoder’s warmup, however bad the reading', () => {
    // Rule 2, and every "2-10 fps" panic in this project's history: a fresh
    // process's first VideoEncoder pays a multi-second init, and judging inside
    // it reads as a hardware failure.
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    const { order } = run(c, 0, WARMUP_MS - 512, starving, max60)
    expect(order).toEqual([])
  })
})

describe('the order of defence, on one induced spike', () => {
  it('sheds the unseen work BEFORE it touches the picture', () => {
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    // warm up honestly first
    run(c, 0, WARMUP_MS + 512, calm, max60)
    // A RECORDING TAKE ALREADY HOLDS THE UNSEEN WORK BACK — the broker's own
    // policy, and it is why rule 8(c) reads `currentPace() !== 'full'`: while a
    // take runs, background work never has the machine to itself.
    const calmPace = currentPace()
    expect(calmPace).not.toBe('full')
    // One starving reading and it goes further — to a full stop, on the same
    // reading the picture rung is decided from, before any rung is spent.
    c.tick(WARMUP_MS + 768, starving(), max60)
    expect(currentPace()).toBe('paused')
  })

  it('spends the camera, then the screen rate, then the size — in that order', () => {
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    run(c, 0, WARMUP_MS + 512, calm, max60)
    const { order, state } = run(c, WARMUP_MS + 768, WARMUP_MS + 768 + SETTLE_MS * 5, starving, max60)
    expect(order).toEqual(['down:camera-fps', 'down:screen-fps', 'down:resolution'])
    expect(state.cameraFps).toBe(FLOOR_FPS)
    expect(state.screenFps).toBe(FLOOR_FPS)
    expect(state.screenLongEdge).toBe(2268)
  })

  it('waits a settle between rungs — it does not spend everything at once', () => {
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    run(c, 0, WARMUP_MS + 512, calm, max60)
    // Less than one settle after the first rung: nothing more may move.
    const { order } = run(c, WARMUP_MS + 768, WARMUP_MS + 768 + SETTLE_MS - 512, starving, max60)
    expect(order).toEqual(['down:camera-fps'])
  })
})

describe('recovery is automatic and in reverse', () => {
  it('gives the size back first, then the screen rate, then the camera', () => {
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    run(c, 0, WARMUP_MS + 512, calm, max60)
    const spent = run(c, WARMUP_MS + 768, WARMUP_MS + 768 + SETTLE_MS * 5, starving, max60)
    expect(spent.order).toHaveLength(3)
    const t = WARMUP_MS + 768 + SETTLE_MS * 5 + 256
    const back = run(c, t, t + SETTLE_MS * 6, calm, spent.state)
    expect(back.order).toEqual(['up:resolution', 'up:screen-fps', 'up:camera-fps'])
    expect(back.state.screenFps).toBe(60)
    expect(back.state.cameraFps).toBe(60)
    expect(back.state.screenLongEdge).toBe(3024)
  })
})

describe('when there is nothing left', () => {
  it('says so instead of going quiet', () => {
    const spent: FloorState = {
      cameraFps: FLOOR_FPS,
      cameraRequestedFps: 60,
      screenFps: FLOOR_FPS,
      screenRequestedFps: 60,
      screenLongEdge: 2268,
      screenRequestedLongEdge: 3024,
    }
    const c = new FloorController({ startedAtMs: 0, requestedFps: 60 })
    run(c, 0, WARMUP_MS + 512, calm, spent)
    let hold: string | null = null
    for (let t = WARMUP_MS + 768; t <= WARMUP_MS + 768 + SETTLE_MS; t += 256) {
      const tick = c.tick(t, starving(), spent)
      if (tick.hold) hold = tick.hold
    }
    expect(hold).toBe('nothing-left')
  })
})
