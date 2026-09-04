/**
 * THE FRAME-SOURCE SEAM (task P9), and the two things about it a test can hold.
 *
 * The rungs themselves cannot be unit-tested — a track processor, a live
 * MediaStream and an AudioWorklet are not things jsdom has, and pretending
 * otherwise would be the instrument measuring itself (note 10). Their evidence
 * is the oracle, on each engine, per the task's gates.
 *
 * What IS testable here is the part that decays: the ORDER, which is the whole
 * promise that a browser missing a rung lands on the next one instead of
 * failing a take, and the STRUCTURE — that there is still only one place in
 * the shipped composite path where a track processor is built.
 */
import { describe, expect, it } from 'vitest'
import {
  INTAKE_DECLARATION,
  intakeArmed,
  intakeFps,
  intakeOrder,
  intakeStateLine,
  setIntakeChoice,
  type IntakeChoice,
} from './frameIntake'
import type { FrameIntakeKind } from '../types'

/** The walk `startLiveCompositeV2` does, with the probes answered by hand. */
function choose(wanted: IntakeChoice, has: Record<FrameIntakeKind, boolean>): FrameIntakeKind | null {
  for (const rung of intakeOrder(wanted)) if (has[rung]) return rung
  return null
}

const CHROMIUM: Record<FrameIntakeKind, boolean> = {
  'main-processor': true,
  'worker-processor': true,
  'element-sampler': true,
}
/** WebKit: the processor exists in workers and nowhere else. */
const WEBKIT: Record<FrameIntakeKind, boolean> = {
  'main-processor': false,
  'worker-processor': true,
  'element-sampler': true,
}
/** Gecko: no processor at all, but WebCodecs and a <video> element. */
const GECKO: Record<FrameIntakeKind, boolean> = {
  'main-processor': false,
  'worker-processor': false,
  'element-sampler': true,
}

describe('which intake a take lands on', () => {
  it('leaves a machine with a main-thread processor exactly where it was', () => {
    expect(choose('auto', CHROMIUM)).toBe('main-processor')
  })

  it('takes the worker-side processor when there is none on the page', () => {
    expect(choose('auto', WEBKIT)).toBe('worker-processor')
  })

  it('falls to the element sampler when there is no processor anywhere', () => {
    expect(choose('auto', GECKO)).toBe('element-sampler')
  })

  /**
   * THE FROZEN RULE, as a test: a rung that is asked for and is not there must
   * not cost a take. Every ask lands somewhere on every machine that has any
   * intake at all.
   */
  it('never refuses a press because the asked-for rung is absent', () => {
    for (const wanted of ['auto', 'main', 'worker', 'element'] as IntakeChoice[]) {
      for (const machine of [CHROMIUM, WEBKIT, GECKO]) {
        expect(choose(wanted, machine)).not.toBeNull()
      }
    }
  })

  it('honours an explicit ask where the machine can honour it', () => {
    expect(choose('worker', CHROMIUM)).toBe('worker-processor')
    expect(choose('element', CHROMIUM)).toBe('element-sampler')
    expect(choose('main', CHROMIUM)).toBe('main-processor')
  })

  it('falls through an explicit ask the machine cannot honour', () => {
    expect(choose('main', WEBKIT)).toBe('worker-processor')
    expect(choose('main', GECKO)).toBe('element-sampler')
    expect(choose('worker', GECKO)).toBe('element-sampler')
  })

  it('has no intake at all when nothing answers', () => {
    expect(
      choose('auto', { 'main-processor': false, 'worker-processor': false, 'element-sampler': false }),
    ).toBeNull()
  })
})

describe('when v2 may take a machine at all', () => {
  /**
   * The arming rule, at the one point a test can reach it here: jsdom has
   * neither a track processor nor a VideoFrame, so it is a machine with no
   * intake, and no intake must never arm v2 — whatever was asked for. The other
   * half of the rule (a sampler-only machine arms only on an explicit ask) is a
   * statement about which ENGINE a Safari or Firefox user gets, and its
   * evidence is that browser's own oracle cell, not a jsdom assertion.
   */
  it('a machine with no intake at all is never armed', () => {
    expect(intakeArmed()).toBe(false)
    setIntakeChoice('element')
    expect(intakeArmed()).toBe(false)
    setIntakeChoice(null)
  })
})

describe('what a rung declares', () => {
  /**
   * A silent difference between rungs is a defect, so every rung has to answer
   * every axis — a new field on the contract fails here until all three have
   * an answer for it.
   */
  it('every rung answers every axis', () => {
    for (const kind of Object.keys(INTAKE_DECLARATION) as FrameIntakeKind[]) {
      const d = INTAKE_DECLARATION[kind]
      expect(d.kind).toBe(kind)
      expect(d.maxFps).toBeGreaterThan(0)
      expect(['source', 'sampled']).toContain(d.frameClock)
      expect(['track', 'beat']).toContain(d.liveness)
      expect(typeof d.mainThreadPixels).toBe('boolean')
    }
  })

  it('a processor rung imposes no rate ceiling of its own', () => {
    expect(intakeFps(INTAKE_DECLARATION['main-processor'], 60)).toBe(60)
    expect(intakeFps(INTAKE_DECLARATION['worker-processor'], 60)).toBe(60)
  })

  /**
   * The sampler's tick is 125 Hz, so 60 is the rate it can actually pace. A
   * take that asks for more is told before the press, not after.
   */
  it('the sampler refuses a rate it cannot pace, before the press', () => {
    expect(intakeFps(INTAKE_DECLARATION['element-sampler'], 30)).toBe(30)
    expect(intakeFps(INTAKE_DECLARATION['element-sampler'], 60)).toBe(60)
    expect(intakeFps(INTAKE_DECLARATION['element-sampler'], 120)).toBe(60)
    expect(intakeStateLine(INTAKE_DECLARATION['element-sampler'], 120)).toContain(
      'asked for 120 and gets 60',
    )
  })

  it('the state line names the rung and every way it differs', () => {
    const line = intakeStateLine(INTAKE_DECLARATION['element-sampler'], 30)
    expect(line).toContain('element-sampler')
    expect(line).toContain('the moment it was read')
    expect(line).toContain('the main thread builds each frame')
    const main = intakeStateLine(INTAKE_DECLARATION['main-processor'], 30)
    expect(main).toContain("the source's own rate")
    expect(main).toContain('the main thread paints nothing')
    expect(main).not.toEqual(line)
  })
})

/**
 * THE SEAM IS THE ONLY WAY IN — the same structural gate M1 put on the door,
 * for the same reason: a written rule decays, a census fails the build.
 *
 * Scanned as the two ACCESS forms — `.MediaStreamTrackProcessor` and a `?:` on
 * a global's shape — never the bare word, so the prose that explains the seam
 * in half a dozen headers does not count itself. Those two forms are the whole
 * surface: the identifier is absent from the TS DOM lib, so nothing can write
 * `new MediaStreamTrackProcessor(...)` and typecheck. It has to be read off a
 * global first, and reading it off a global is what this catches.
 */
const SOURCE = import.meta.glob('/src/{core,app}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function hits(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [path, src] of Object.entries(SOURCE)) {
    if (/\.test\.tsx?$/.test(path)) continue
    const n = src.match(pattern)?.length ?? 0
    if (n > 0) found[path.replace(/^\//, '')] = n
  }
  return found
}

describe('the seam is the only way a composite frame gets in', () => {
  /**
   * A census with a reason per file, not a ban: three pipelines legitimately
   * read a track, and they are not the same pipeline. A NEW one moves a count
   * and fails the build, and whoever added it has to answer why the composite's
   * frames are reaching the worker past the seam.
   */
  it('only frameIntake builds a track processor for the composite', () => {
    expect(
      hits(/\.MediaStreamTrackProcessor\b|MediaStreamTrackProcessor\s*\?:/g),
    ).toEqual({
      // THE SEAM. One probe, called from the page for the main rung and from
      // inside compositor.worker.ts for the worker rung.
      'src/core/capture/frameIntake.ts': 3,
      // A1's audio tap — AudioData, not VideoFrame, and it never reaches the
      // compositor. A different seam with its own fallback (the AudioWorklet).
      'src/core/capture/audioTap.ts': 3,
      // X6's raw video channel — its own encoder, its own file, its own worker.
      // It does not go through the composite at all.
      'src/core/capture/measuredVideo.ts': 3,
    })
  })
})
