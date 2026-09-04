/**
 * SINGLE-GENERATION EXPORT — how far O3b is allowed to go on this load.
 *
 * A take is "single generation" when one raw video channel ALREADY IS the
 * default composition: exactly one video channel, encoded as AVC in fragmented
 * MP4 (X6's path, the default since 2026-08-26), at exactly the export
 * geometry — so the live compositor's contain-fit into its own 1920x1080
 * canvas is the identity, and the composite is a re-encode of a picture we
 * already have.
 *
 * WHY IT IS WORTH A FLAG AT ALL. X15(d) measured what that second encode
 * costs, against the canvas the source actually painted: the raw screen
 * channel keeps 80.0 % of the source's green, the composite keeps 70.3 %, and
 * the unedited export is the composite byte for byte. So copying the RAW
 * channel instead recovers about a third of the total colour loss for
 * STRICTLY LESS WORK. R1 then controlled the attribution — flat slabs of the
 * same colours through the same encoder keep 99-101 %, thin glyphs 80-82 % —
 * so this is 4:2:0 on glyph edges, and one generation of it beats two.
 *
 * THE TWO RUNGS:
 *
 *   off      the copy paths read the composite, where a take still has one.
 *   export   the copy paths prefer the raw channel when the take qualifies.
 *            This is a better file for the same work.
 *
 * THERE WAS A THIRD, `capture`, AND J6 DELETED IT (2026-09-04). It ALSO skipped
 * recording the composite on a qualifying take — the CPU and write-bandwidth
 * half — but it did so by stopping the whole compositor, which took source
 * liveness ("your screen froze") and the composited preview with it. That is
 * why it was never flipped on. J6 does the same saving without the losses: the
 * compositor keeps painting and simply never encodes, on EVERY take, so there
 * is nothing left for this rung to turn on. See `core/glue.ts` and `?glue=`.
 *
 *   ?singlegen=off|export   (this load only)
 *   localStorage['inout.compose.singlegen']   (sticky)
 * A URL parameter wins, then a runtime setSingleGenRung, then storage, then
 * the default.
 */

// U4 2026-09-04: `capture` is GONE from this type as well as from the code.
// J6 deleted the rung; the type kept offering it, `isRung` had always
// refused it, and the panel showed it as a third option that did nothing
// when pressed. A switch position that cannot be reached is the mess this
// task is named after.
export type SingleGenRung = 'off' | 'export'

const STORAGE_KEY = 'inout.compose.singlegen'

/**
 * DEFAULT: `export`.
 *
 * It is the rung that takes nothing away, and the evidence for it is in
 * `npm run exp -- o3b`: on a screen-only 1080p take the single-generation file
 * keeps the source's colour where the composite loses a second helping of it,
 * at no extra work and no extra bytes.
 */
const DEFAULT_RUNG: SingleGenRung = 'export'

function isRung(v: string | null): v is SingleGenRung {
  return v === 'off' || v === 'export'
}

function fromSearch(): SingleGenRung | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('singlegen')
  // `?singlegen=1` / `=0` are the shapes every other flag here takes; accept
  // them rather than silently falling through to the default.
  if (v === '1' || v === 'true') return 'export'
  if (v === '0' || v === 'false') return 'off'
  return isRung(v) ? v : null
}

function fromStorage(): SingleGenRung | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isRung(v) ? v : null
  } catch {
    return null
  }
}

/**
 * What `setSingleGenRung` last asked for, held in the module as well as in
 * storage. A rig runs in a worker or a test runs in node — neither has
 * localStorage, and a setter that silently does nothing there is a flag that
 * cannot be exercised by the gate that is supposed to prove it works.
 */
let override: SingleGenRung | null = null

export function singleGenRung(): SingleGenRung {
  return fromSearch() ?? override ?? fromStorage() ?? DEFAULT_RUNG
}

/** `null` clears the sticky choice and returns the rung to its default. */
export function setSingleGenRung(rung: SingleGenRung | null): void {
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

/** May an EXPORT copy the raw channel instead of the composite? */
export function singleGenExportEnabled(): boolean {
  return singleGenRung() !== 'off'
}
