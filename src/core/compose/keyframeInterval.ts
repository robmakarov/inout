/**
 * THE KEYFRAME INTERVAL, WHICH IS ALSO THE CHUNK GRID.
 *
 * One number decides two things at once, and that is why it is worth a file.
 * The chunked export concatenates by PACKET COPY, so a chunk must begin on a
 * keyframe — the grid IS the output's GOP. Small grid: an edit re-encodes less.
 * Small grid: more keyframes in the delivered file, so more bytes, and one
 * muxer finalize (59 ms, flat — J7) per chunk file on the first press.
 *
 * RULED 2026-09-04 by Robert on J7's measured trade, on a 30 s take at 1080p30:
 *
 *      grid   a small edit    the file     first press
 *      5 s      1758 ms        4926 KB       5598 ms
 *    → 2.5 s    1443 ms  −18%  5073 KB +3%   5770 ms +3%
 *      1 s      1341 ms  −24%  5511 KB +12%  6733 ms +20%
 *
 * 2.5 s is the knee: a fifth off the thing he asked to be faster — "we must
 * make easy short edits faster anyway, despite we have huge ones" — for three
 * per cent of file. Past it the muxer's per-file cost triples and the bytes run
 * away. `?gop=5` puts the previous behaviour back, unchanged, at runtime.
 */

/** Robert's ruling, 2026-09-04. */
export const KEYFRAME_INTERVAL_DEFAULT_SEC = 2.5

/** What shipped before that ruling, kept as the switch's other position. */
export const KEYFRAME_INTERVAL_PREVIOUS_SEC = 5

export const GOP_STORAGE_KEY = 'inout.gopSec'

/** Anything outside this is a typo, not a choice. */
const MIN_SEC = 0.5
const MAX_SEC = 30

function parseGop(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < MIN_SEC || n > MAX_SEC) return undefined
  return n
}

/**
 * Module-level override, so the export WORKER can be told what the page chose.
 * The same seam constantQuality.ts and loudnessMode.ts have, and for the same
 * reason: a worker has no `localStorage` and its `location` is its own script
 * URL, so a switch read only from the page is a switch that does nothing on the
 * path that renders (found 2026-08-30, three flags dead since O5a).
 */
let forced: number | undefined
export function setKeyframeIntervalOverride(sec: number | undefined): void {
  forced = sec
}

export function keyframeIntervalSec(): number {
  if (forced !== undefined) return forced
  if (typeof location !== 'undefined') {
    const fromSearch = parseGop(new URLSearchParams(location.search).get('gop'))
    if (fromSearch !== undefined) return fromSearch
  }
  try {
    const fromStorage = parseGop(localStorage.getItem(GOP_STORAGE_KEY))
    if (fromStorage !== undefined) return fromStorage
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
  return KEYFRAME_INTERVAL_DEFAULT_SEC
}

export function setKeyframeInterval(sec: number | null): void {
  try {
    if (sec === null) localStorage.removeItem(GOP_STORAGE_KEY)
    else localStorage.setItem(GOP_STORAGE_KEY, String(sec))
  } catch {
    /* storage unavailable */
  }
}
