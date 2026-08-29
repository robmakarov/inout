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
 * THE THREE RUNGS, and they are separate because their risks are not alike:
 *
 *   off      exactly today. Both copy paths read the composite.
 *   export   the copy paths prefer the raw channel when the take qualifies.
 *            The composite is still RECORDED and is still the fallback, so
 *            nothing is lost if the take turns out not to qualify. This is a
 *            better file for the same work.
 *   capture  ALSO skip recording the composite on a qualifying take. This is
 *            the CPU and write-bandwidth half — a whole encoder that never
 *            runs — and it is the rung that gives something up:
 *              · SOURCE LIVENESS lives inside the compositor, so "your screen
 *                froze" detection goes with it (capture/sourceLiveness.ts);
 *              · the recording PREVIEW can no longer render the compositor's
 *                own output and falls back to the raw <video> preview;
 *              · a take whose measured-video start FALLS BACK to MediaRecorder
 *                mid-start has neither a composite nor a copyable channel, so
 *                its unedited export renders.
 *            Each is a real capability, so this rung is PO's to flip on
 *            evidence — the same shape X6 shipped in, and X6's flip is the
 *            precedent. `npm run exp -- o3b` prices it.
 *
 *   ?singlegen=off|export|capture   (this load only)
 *   localStorage['inout.compose.singlegen']   (sticky)
 * A URL parameter wins, then a runtime setSingleGenRung, then storage, then
 * the default.
 */

export type SingleGenRung = 'off' | 'export' | 'capture'

const STORAGE_KEY = 'inout.compose.singlegen'

/**
 * DEFAULT: `export`.
 *
 * It is the rung that takes nothing away — the composite keeps being recorded
 * and keeps being the fallback for every take that does not qualify — and the
 * evidence for it is in `npm run exp -- o3b`: on a screen-only 1080p take the
 * single-generation file keeps the source's colour where the composite loses a
 * second helping of it, at no extra work and no extra bytes. `capture` stays
 * opt-in until PO rules, because that one gives capabilities up.
 */
const DEFAULT_RUNG: SingleGenRung = 'export'

function isRung(v: string | null): v is SingleGenRung {
  return v === 'off' || v === 'export' || v === 'capture'
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

export function setSingleGenRung(rung: SingleGenRung): void {
  override = rung
  try {
    localStorage.setItem(STORAGE_KEY, rung)
  } catch {
    /* storage unavailable — the in-module value above still holds */
  }
}

/** May an EXPORT copy the raw channel instead of the composite? */
export function singleGenExportEnabled(): boolean {
  return singleGenRung() !== 'off'
}

/** May CAPTURE skip the live composite entirely on a qualifying take? */
export function singleGenCaptureEnabled(): boolean {
  return singleGenRung() === 'capture'
}
