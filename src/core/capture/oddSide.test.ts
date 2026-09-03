import { describe, expect, it } from 'vitest'
import { evenDown } from '@core/frame'
import { rateForSurface } from '@core/rate'

/**
 * THE FREEZE OF 2026-08-30, and it was not "too much load" — it was one odd
 * pixel taking the whole take off the hardware encoder.
 *
 * Robert: "?sourcefps=1 - record froze on game tab again". Reproduced on a
 * QUIET machine with no game at all, from his own configuration
 * (`screensize=3024x1964`, sourcefps on, native res at its shipped default):
 *
 *   [capture] native-res capture: 3024×1964 is past the largest export step
 *             (2560 long edge) … so recording 2560×1663 (O6)
 *   [capture] 2560×1663 has an odd side, which AVC cannot encode —
 *             asked for 2560×1662, got 2559×1662
 *   [capture] measured video unavailable, using MediaRecorder for screen
 *             Error: rawVideo: no supported AVC VideoEncoder config
 *   [capture] live composite stop failed TimeoutError: … after 5000ms
 *   …and the take produced NO channels and no composite at all.
 *
 * THE CHAIN: the capture ceiling asks for 2560 on the long edge; Chrome hands
 * back 2560x1663, an odd HEIGHT; capDisplayTrack asks for 2560x1662 to even it;
 * Chrome re-derives the width from the aspect and returns 2559x1662, an odd
 * WIDTH. The 2026-08-29 odd-side fix evened the TRACK and stopped there, on the
 * reasoning that every consumer then sees an encodable frame — but Chrome is
 * free to refuse the constraint, and when it did, every AVC candidate was
 * unsupported and the raw channel fell back to MediaRecorder's SOFTWARE
 * VP8/VP9 at 2559x1662@60. Software-encoding 4.25 Mpx at 60 fps is the freeze.
 *
 * The braces are now in the workers, where the size can be known for certain.
 * Measured in Chrome 151 before the fix was written: 2559x1662 AVC unsupported,
 * 2558x1662 supported, and an encoder configured at 2558 accepts a 2559-wide
 * VideoFrame and emits a chunk with no error.
 */
describe('the size an encoder is configured at', () => {
  it("evens DOWN, because up is a size the source does not have", () => {
    expect(evenDown(2559)).toBe(2558)
    expect(evenDown(1663)).toBe(1662)
  })

  it('leaves an already-even size exactly alone — no take changes shape for this', () => {
    for (const n of [1920, 1080, 2560, 1662, 3024, 1964, 1280, 720]) {
      expect(evenDown(n)).toBe(n)
    }
  })

  it("THE CASE ITSELF: what Chrome handed back is one column off an encodable size", () => {
    // Not a rounding preference — an odd side makes EVERY AVC config
    // unsupported, so the difference between these two numbers is the
    // difference between a hardware encoder and a software one.
    const fromChrome = { width: 2559, height: 1662 }
    expect(evenDown(fromChrome.width) % 2).toBe(0)
    expect(evenDown(fromChrome.height) % 2).toBe(0)
    expect(fromChrome.width - evenDown(fromChrome.width)).toBe(1)
  })
})

/**
 * …AND THE SECOND HALF OF THE SAME FREEZE: what a take is allowed to ATTEMPT.
 *
 * `rateForSurface` capped 60 fps above a 2560 long edge — a SIZE standing in
 * for a CAPABILITY, which rate.ts's own header already argues against. It had
 * an accidental cliff Robert's take fell straight through, and once F18 lifted
 * the capture ceiling it forced 30 fps at exactly the resolution the flag
 * exists to deliver.
 */
describe('what a machine may attempt', () => {
  const MEASURED = 416e6 // Robert's machine, one hardware AVC encoder, idle
  // AND THE FRAME IT WAS MEASURED AT (B14). 416 Mpx/s is what that machine
  // reads AT 3024x1964; at 1920x1080 the same encoder reads 330-362, and
  // spending the small frame's number on the big frame's demand is what held
  // every max take at 30. A reading now carries its own geometry, and one
  // taken below the surface may inform an attempt but never a refusal.
  const AT = { width: 3024, height: 1964 }

  it("allows his own screen at 60 — 356 Mpx/s against a measured 416", () => {
    expect(rateForSurface(3024, 1964, 60, MEASURED, AT)).toBe(60)
  })

  it('refuses a rate the machine measurably cannot carry, and drops the RATE', () => {
    // 4K60 is 498 Mpx/s. Resolution is never the thing that gives — his rule.
    expect(rateForSurface(3840, 2160, 60, MEASURED, { width: 3840, height: 2160 })).toBe(30)
  })

  it('THE CLIFF THE FREEZE FELL THROUGH is gone', () => {
    // The old rule allowed 60 at a 2559 long edge and forced 30 at 2561, so the
    // worst case this product can make — just under the ceiling, at full rate —
    // was the one case nothing checked.
    expect(rateForSurface(2559, 1662, 60, MEASURED, AT)).toBe(60)
    expect(rateForSurface(2561, 1663, 60, MEASURED, AT)).toBe(60)
  })

  it('an UNMEASURED machine keeps exactly the old rule — no experiments', () => {
    expect(rateForSurface(3024, 1964, 60, 0)).toBe(30)
    expect(rateForSurface(1920, 1080, 60, 0)).toBe(60)
  })

  it('a 30 fps ask is never touched, measured or not', () => {
    expect(rateForSurface(3840, 2160, 30, MEASURED)).toBe(30)
    expect(rateForSurface(3840, 2160, 30, 0)).toBe(30)
  })
})
