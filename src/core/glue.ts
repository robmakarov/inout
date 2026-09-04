/**
 * THE GLUED COPY — IS IT ENCODED, OR ONLY PAINTED? (task J6.)
 *
 * "the glued copy" is Robert's name for the live composite: the screen and the
 * camera drawn into one picture while the take runs. Until J6 that picture was
 * PAINTED and then ENCODED into a second MP4 beside the raw channels, on every
 * take that opened a compositor at all.
 *
 * robert 2026-09-04 (27): "kill the glued copy encoding and do background render
 * while editing". Two numbers decided it, and both are his:
 *  · ANY REAL EDIT RENDERS. `choose.ts` — anything that changes PIXELS cannot be
 *    copied through — so a zoom, a camera move or a background sends the export
 *    down the full render path and the composite file is never opened. He has
 *    never seen an instant export, which is consistent with that.
 *  · ASSUME EVERY TAKE IS EDITED (his instruction; he prices the unedited case
 *    at ~10 %). Under that assumption the composite was written on every take
 *    and read on none, while costing a whole hardware encoder — the one the
 *    encoder budget already sheds FIRST under pressure, and the one max/60 fps
 *    runs out of.
 *
 * WHAT STAYS, and it is why this is a rung and not a deletion: the compositor
 * keeps PAINTING. His words are "we need preview". The recording preview and
 * source liveness ("your screen froze") both come from the paint, not from the
 * encode, so neither is given up here — which is exactly what separates J6 from
 * the `?singlegen=capture` rung it replaces and deletes. That rung stopped the
 * whole compositor and took the preview and the liveness detector with it.
 *
 * WHAT IT COSTS, said plainly: an UNEDITED take with a camera has no file to
 * packet-copy any more, so its export renders. J5 is what makes that free —
 * the render is made in the background while he edits (and at stop), on J1's
 * content-keyed chunks — and the ORDER was part of the ruling: J5 landed first.
 * A screen-only take never had anything to lose here: single generation's
 * default rung already copies the raw screen channel, not the composite.
 *
 *   ?glue=paint     the composite is painted and never encoded (DEFAULT, J6)
 *   ?glue=record    the take that was recorded yesterday — paint AND encode
 *   localStorage['inout.compose.glue']   (sticky)
 *
 * A URL parameter wins, then a runtime setGlueRung, then storage, then the
 * default. `record` is here because the thing being replaced carries the switch
 * (CLAUDE.md's frozen rule): it puts the second encoder, the second file and
 * every path that reads it back exactly as they were.
 */

export type GlueRung = 'paint' | 'record'

const STORAGE_KEY = 'inout.compose.glue'

/**
 * DEFAULT: `paint`. Robert's ruling, executed — not an experiment waiting for
 * evidence. The evidence he ruled from is quoted above.
 */
const DEFAULT_RUNG: GlueRung = 'paint'

function isRung(v: string | null): v is GlueRung {
  return v === 'paint' || v === 'record'
}

function fromSearch(): GlueRung | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('glue')
  // `?glue=1` / `=0` are the shapes every other flag here takes; accept them
  // rather than silently falling through to the default. `1` is the OLD
  // behaviour, because that is what a flag named after the thing turns on.
  if (v === '1' || v === 'true') return 'record'
  if (v === '0' || v === 'false') return 'paint'
  return isRung(v) ? v : null
}

function fromStorage(): GlueRung | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isRung(v) ? v : null
  } catch {
    return null
  }
}

/**
 * What `setGlueRung` last asked for, held in the module as well as in storage.
 * A rig runs in a worker or a test runs in node — neither has localStorage, and
 * a setter that silently does nothing there is a flag that cannot be exercised
 * by the gate that is supposed to prove it works.
 */
let override: GlueRung | null = null

export function glueRung(): GlueRung {
  return fromSearch() ?? override ?? fromStorage() ?? DEFAULT_RUNG
}

/** `null` clears the sticky choice and returns the rung to its default. */
export function setGlueRung(rung: GlueRung | null): void {
  override = rung
  try {
    if (rung === null) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, rung)
  } catch {
    /* storage unavailable — the in-module value above still holds */
  }
}

/** Is the composite ENCODED and written to disk, as it was before J6? */
export function glueRecorded(): boolean {
  return glueRung() === 'record'
}
