/**
 * SILENCE TIGHTENING (task F5a) — the half that touches the audio.
 *
 * Opens exactly the mixers the export would open, over exactly the current
 * edit, and measures exactly the envelope the loudness normalizer measures. So
 * what the proposal calls quiet is what the exported file will contain, not an
 * approximation of it made by a second, differently-tuned analyser.
 *
 * Lives in compose (not timeline) because it decodes: it is part of the lazily
 * loaded editor chunk, and timeline stays pure and first-paint-cheap.
 */
import type { EditState, Recording } from '@core/types'
import {
  SILENCE_DEFAULTS,
  analyzeEnvelope,
  proposeTightening,
  type SilenceParams,
  type TightenProposal,
} from '@core/timeline/silence'
import { outputDurationMs } from '@core/timeline'
import { busGainFor, measureMixEnvelope, openAudioMixers } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

export interface TightenResult {
  proposal: TightenProposal | null
  /** Why there is nothing to propose, when there isn't. */
  reason?: string
}

export async function analyzeSilence(
  recording: Recording,
  edit: EditState,
  params: SilenceParams = SILENCE_DEFAULTS,
): Promise<TightenResult> {
  // The export's own construction, not a copy of it: F5b made the two capable
  // of disagreeing about how long a span lasts, and an envelope measured on a
  // different timeline proposes cuts in the wrong places.
  const mixers = await openAudioMixers(recording, edit, () => {})
  if (mixers.length === 0) return { proposal: null, reason: 'this take has no audio to analyse' }
  try {
    const outputMs = outputDurationMs(edit)
    const totalAudioFrames = Math.round((outputMs / 1000) * AUDIO_SAMPLE_RATE)
    // The same base gain the export applies, so the envelope is the mix's, not
    // one channel's — a threshold measured at a different gain is a different
    // threshold.
    const gain = busGainFor(mixers)
    const envelope = await measureMixEnvelope(mixers, gain, totalAudioFrames, () => {})
    // floorRms is optional on MixLoudness (older callers omit it); absent means
    // "no floor evidence", which the analyser reads as an unbounded threshold.
    const floorRms = envelope.floorRms ?? 0
    const analysis = analyzeEnvelope(
      envelope.windowRms,
      envelope.windowMs,
      envelope.loudRms,
      floorRms,
      params,
    )
    const proposal = proposeTightening(edit, analysis)
    console.info(
      `[silence] loud ${envelope.loudRms.toFixed(4)} floor ${floorRms.toFixed(4)} ` +
        `threshold ${analysis.thresholdRms.toFixed(4)} — ${analysis.raw.length} quiet stretches, ` +
        `${analysis.cuts.length} worth cutting, ${proposal ? Math.round(proposal.removedMs) : 0} ms removed`,
    )
    if (!proposal) {
      return {
        proposal: null,
        reason: analysis.reason ?? 'no silences long enough to be worth cutting',
      }
    }
    return { proposal }
  } finally {
    for (const m of mixers) m.dispose()
  }
}
