/**
 * HOW BIG THE ENCODER'S BURST ABSORBER MAY BE ON THIS MACHINE — task E2,
 * layer two of the order of defence.
 *
 * Robert, 2026-09-02: shed the unseen work → ABSORB A BURST IN A MEMORY-BOUNDED
 * QUEUE (bound sized to the machine; 8 GB gets a small one) → the smallest
 * picture step. Layer two did not exist: the seventh frame behind a busy
 * encoder was DROPPED, so a 200 ms hiccup — a keyframe, a window drag, another
 * tab starting — came out of the file as lost frames rather than out of a
 * buffer.
 *
 * WHY IT IS A BYTE BUDGET AND NOT A FRAME COUNT, and this is the whole file: a
 * queued frame is memory, and "four frames" is 12 MB at 1080p and 50 MB at 4K.
 * The same number is a very different promise about a machine with 8 GB in it.
 * So the budget is bytes, sized to the machine, and the frame count falls out.
 *
 * Measured against the geometries this product actually opens, at 8 GB: four
 * frames at 1920x1080 (12.4 MB), two at Robert's 3024x1964 (17.0 MB), two at
 * 3840x2160 (23.7 MB). The worst case a machine ever holds is the budget.
 *
 * AND IT IS ALSO CAPPED IN FRAMES, because memory is not the only cost: a
 * queued frame is latency at stop. Four frames is 67 ms at 60 fps — inside one
 * keyframe interval and far inside the 5 s stop budget — and no amount of RAM
 * buys a fifth.
 *
 * This lives in core/capture rather than inside the worker so it can be read
 * without a browser: it is a policy number, and a policy number that can only
 * be checked by running a take is a number nobody checks.
 */

/** An 8 GB machine (Robert's M3). Deliberately small. */
export const BURST_BUDGET_BYTES_SMALL = 24 * 1024 * 1024
/** Anything larger. Still bounded — see the frame cap. */
export const BURST_BUDGET_BYTES = 96 * 1024 * 1024
/** The latency ceiling, in frames, whatever the memory says. */
export const MAX_BURST_FRAMES = 4
/** Machines at or below this many GB get the small budget. */
export const SMALL_MACHINE_GB = 8

/**
 * Bytes one queued frame costs. NV12 (4:2:0 8-bit) is what a hardware AVC
 * encoder holds — 1.5 bytes per pixel. An overestimate would be safer and a
 * wrong number here is a wrong promise, so this is the real one.
 */
export function frameBytes(width: number, height: number): number {
  return Math.max(1, Math.round(width * height * 1.5))
}

/**
 * How many frames past the steady queue bound this machine may hold.
 *
 * `deviceMemoryGB` is `navigator.deviceMemory`, which Chrome reports in coarse
 * powers of two and which is absent in some contexts — absent is treated as 8,
 * i.e. the SMALL budget, because guessing a machine is big is the guess that
 * costs a user memory they do not have.
 */
export function burstFramesFor(
  width: number,
  height: number,
  deviceMemoryGB?: number | null,
): number {
  const gb = typeof deviceMemoryGB === 'number' && deviceMemoryGB > 0 ? deviceMemoryGB : SMALL_MACHINE_GB
  const budget = gb <= SMALL_MACHINE_GB ? BURST_BUDGET_BYTES_SMALL : BURST_BUDGET_BYTES
  return Math.max(0, Math.min(MAX_BURST_FRAMES, Math.floor(budget / frameBytes(width, height))))
}

// ---------------------------------------------------------------------------
// THE FLAG. The frozen rule (never break a working path) asks every new engine
// to keep the old one reachable at runtime, and here the old one is exactly
// "the seventh frame behind a busy encoder is dropped". `?burst=0` is that, and
// it is also the A/B CONTROL the absorber's gate is read against — the same
// build, the same machine, one URL apart.
//
//   ?burst=1|0                             (this load only)
//   localStorage['inout.capture.burst']    (sticky)
// ---------------------------------------------------------------------------

const FLAG_KEY = 'inout.capture.burst'

let override: boolean | null = null

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('burst')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(FLAG_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * ON BY DEFAULT, and the reason is that the thing it replaces was never a
 * decision: dropping the frame past a queue of six was the only behaviour that
 * existed, and Robert's ruling of 2026-09-02 names the buffer as the layer that
 * must come BEFORE the picture moves. Nothing a user can see changes — a frame
 * that is kept instead of dropped is the take being MORE complete — and the
 * memory it costs is bounded above by the budget in this file.
 */
export function burstAbsorberEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? true
}

export function setBurstAbsorber(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}
