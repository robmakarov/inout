/**
 * Which loudness statistic the export normalises to (task O10a).
 *
 * `p90` is what ships: the 90th percentile of 100 ms window RMS, driven to a
 * fixed target. It is unweighted and ungated, and MEASURED CONSEQUENCE of that
 * (`npm run exp -- o10`): three takes of the same nominal level land 7.85 dB
 * apart — speech-like −13.1 LUFS, bass-heavy −10.2, bright −5.2. A viewer
 * moving between two INOUT exports hears that difference.
 *
 * `r128` is EBU R128 / BS.1770 integrated loudness targeted at −14 LUFS, which
 * is the convention every other thing on the user's screen is normalised to.
 * It costs a probe pass over the mixed audio (K-weighting has to see the actual
 * signal — the capture-time envelope X1 keeps has no frequency weighting and
 * cannot answer this).
 *
 * THE DEFAULT IS `p90` AND STAYS THERE. O10's own instruction is "as an
 * ADDITIVE mode first — current behavior stays until parity proven", and parity
 * is not merely unproven here, it is measured to be false: the whole point of
 * r128 is that it CHANGES the level of anything that is not speech-shaped. That
 * is a decision about how every export sounds, so it is PO's.
 *
 *   ?loudness=r128   (this load only)
 *   localStorage['inout.export.loudness'] = 'r128'   (sticky)
 */

export type LoudnessMode = 'p90' | 'r128'

const STORAGE_KEY = 'inout.export.loudness'

function isMode(v: string | null): v is LoudnessMode {
  return v === 'p90' || v === 'r128'
}

function fromSearch(): LoudnessMode | null {
  if (typeof location === 'undefined') return null
  return isMode(new URLSearchParams(location.search).get('loudness'))
    ? (new URLSearchParams(location.search).get('loudness') as LoudnessMode)
    : null
}

function fromStorage(): LoudnessMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isMode(v) ? v : null
  } catch {
    return null
  }
}

/** Module-level override, so the export worker can be told what the page chose. */
let forced: LoudnessMode | null = null
export function setLoudnessMode(mode: LoudnessMode | null): void {
  forced = mode
}

export function loudnessMode(): LoudnessMode {
  return forced ?? fromSearch() ?? fromStorage() ?? 'p90'
}
