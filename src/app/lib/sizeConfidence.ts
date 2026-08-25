/**
 * HOW MUCH THE EXPORT PANEL MAY CLAIM FOR A SIZE (task F7d).
 *
 * Three different numbers can sit under a step's label and they are not
 * interchangeable:
 *
 *   exact        the default step — an unedited take copies the composite's
 *                packets, so the number IS the file plus a certified audio
 *                track. Never a prediction, never provisional.
 *   measured     F7c's probe ran: ten seconds of THIS take composed through the
 *                export's own geometry and encoded at this step with the
 *                export's own encoder. −7 to +6 % on both content types.
 *   provisional  F7's model, with the probe still running. It will be replaced
 *                in a few seconds, and the panel says so.
 *   rough        F7's model, with the probe NOT coming. The model is anchored on
 *                the COMPOSITE's byte rate, and the composite's encoder changed
 *                under it when O4 flipped the default capture engine to v2:
 *                scored against a v2 composite it reads −71 to −84 % on motion
 *                content. So this number can be several times out, and the panel
 *                has to say that instead of promising a correction.
 *
 * The distinction that made this a task: `provisional` and `rough` used to be
 * the same state. A probe that could not run — an audio-only take, a take too
 * short to encode, a browser with no VideoEncoder — left "they settle in a few
 * seconds" on screen forever, over numbers nothing was going to settle.
 */
export type ProbeState = 'running' | 'measured' | 'unavailable'

export type SizeConfidence = 'exact' | 'measured' | 'provisional' | 'rough'

export function sizeConfidence(opts: {
  /** This step is the composite copied — the number is the file. */
  exact: boolean
  /** The probe priced THIS step. */
  measured: boolean
  probe: ProbeState
}): SizeConfidence {
  if (opts.exact) return 'exact'
  if (opts.measured) return 'measured'
  return opts.probe === 'running' ? 'provisional' : 'rough'
}

/**
 * What the panel says under the ladder. One sentence, or none: a panel that
 * explains itself twice is a panel nobody reads.
 */
export function sizeNotice(confidences: SizeConfidence[]): 'measuring' | 'rough' | null {
  if (confidences.some((c) => c === 'provisional')) return 'measuring'
  if (confidences.some((c) => c === 'rough')) return 'rough'
  return null
}
