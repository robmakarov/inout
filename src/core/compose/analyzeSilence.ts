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
  type SilenceAnalysis,
  type SilenceParams,
  type TightenProposal,
} from '@core/timeline/silence'
import { keptSegments, outputDurationMs, segmentSpeed } from '@core/timeline'
import { busGainFor, measureMixEnvelope, mixGainForChannels, openAudioMixers } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

export interface TightenResult {
  proposal: TightenProposal | null
  /** Why there is nothing to propose, when there isn't. */
  reason?: string
}

/**
 * The envelope this analysis needs, built from what CAPTURE already measured
 * (task X1) instead of by decoding every audio channel again.
 *
 * Deliberately narrower than the makeup-gain shortcut, because silence
 * detection cares WHERE the quiet is and not just how much of it there was:
 * the analyser indexes its windows by OUTPUT position, so a selection of
 * source windows is only usable when it maps onto the output grid exactly.
 * That is one kept span. A take that has already been cut goes back to the
 * decode — it is shorter by then anyway, which is the whole point of the cuts.
 *
 * Where the take has no audio (audio started late, or ended before the video)
 * the array is padded with zero-RMS windows, because that is precisely what the
 * probe measures there: the mixers write digital silence into the output span.
 *
 * `offsetMs` is what the caller must add to every reported instant — the
 * sub-window remainder between where the envelope's grid sits and where the
 * output's does. It is exact; nothing here rounds a cut boundary.
 *
 * KNOWN LIMIT, stated because the rig cannot reach it: capture measures PCM and
 * the probe measures the DECODED FILE, and a lossy codec removes content below
 * its perceptual floor (O2 measured up to 15 dB apart down there). On the
 * known-silence rig the two floors agree to 0.04 dB and the proposal is
 * identical, and the threshold is hard-capped at 0.35 × the speech level where
 * the two agree to 0.03 dB — so the exposure is a take whose room tone sits
 * BELOW the codec floor, where this would read the floor higher than the file's
 * and propose slightly more aggressively. It is a proposal the user presses
 * Apply on, not an edit.
 */
function envelopeFromCapture(
  recording: Recording,
  edit: EditState,
  outputMs: number,
): { windowRms: Float32Array; windowMs: number; loudRms: number; floorRms: number; offsetMs: number } | null {
  const stats = recording.loudness
  const env = stats?.envelope
  if (!stats || !env) return null
  const n = Math.min(env.windowRms.length, env.windowPeak.length)
  const w = env.windowMs
  if (n <= 0 || !(w > 0) || !(outputMs > 0)) return null

  const segs = keptSegments(edit)
  if (segs.length !== 1) return null
  const seg = segs[0]!
  if (segmentSpeed(seg) !== 1) return null

  // The stored envelope is the sum of EXACTLY these channels at unity; a
  // disabled or trimmed channel makes it describe a different signal.
  const enabled: string[] = []
  for (const c of recording.channels) {
    if (c.media !== 'audio') continue
    const ce = edit.channels.find((x) => x.channelId === c.id)
    if (!ce || !ce.enabled) continue
    if (ce.trimStartMs > 0 || ce.trimEndMs < c.durationMs) return null
    enabled.push(c.id)
  }
  if (enabled.length !== stats.channelIds.length) return null
  if (!enabled.every((id) => stats.channelIds.includes(id))) return null

  const first = Math.max(0, Math.ceil((seg.startMs - env.startMs) / w))
  const last = Math.min(n - 1, Math.ceil((seg.endMs - env.startMs) / w) - 1)
  if (last < first) return null

  // Output ms at which the first kept window starts, split into whole windows
  // of lead-in silence and an exact sub-window remainder.
  const startOut = env.startMs + first * w - seg.startMs
  const lead = Math.max(0, Math.floor(startOut / w))
  const offsetMs = startOut - lead * w
  const total = Math.max(lead + (last - first + 1), Math.ceil(outputMs / w))
  const windowRms = new Float32Array(total)
  // Capture summed at UNITY; the export mixes at the bus gain. The threshold is
  // homogeneous in the envelope so the CLASSIFICATION is invariant to it — but
  // the reported loud/floor levels are not, and they are read by the rig and the
  // console line, so scale here rather than quote a level nothing will produce.
  const gain = enabled.length > 1 ? mixGainForChannels(enabled.length) : 1
  for (let i = first; i <= last; i++) windowRms[lead + (i - first)] = env.windowRms[i]! * gain

  const sorted = Float32Array.from(windowRms).sort()
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { windowRms, windowMs: w, loudRms: at(0.9), floorRms: at(0.2), offsetMs }
}

export async function analyzeSilence(
  recording: Recording,
  edit: EditState,
  params: SilenceParams = SILENCE_DEFAULTS,
): Promise<TightenResult> {
  const outputMs = outputDurationMs(edit)

  // X1: capture already measured this envelope; when it covers exactly this
  // mix over one kept span, the decode below is rebuilding numbers we have.
  const stored = envelopeFromCapture(recording, edit, outputMs)
  if (stored) {
    const analysis = analyzeEnvelope(
      stored.windowRms,
      stored.windowMs,
      stored.loudRms,
      stored.floorRms,
      params,
    )
    const shift = (s: { startMs: number; endMs: number }): { startMs: number; endMs: number } => ({
      startMs: s.startMs + stored.offsetMs,
      endMs: s.endMs + stored.offsetMs,
    })
    const shifted: SilenceAnalysis = {
      ...analysis,
      cuts: analysis.cuts.map(shift),
      raw: analysis.raw.map(shift),
    }
    const proposal = proposeTightening(edit, shifted)
    console.info(
      `[silence] from capture envelope (no decode) — loud ${shifted.loudRms.toFixed(4)} ` +
        `floor ${shifted.floorRms.toFixed(4)} threshold ${shifted.thresholdRms.toFixed(4)} — ` +
        `${shifted.raw.length} quiet stretches, ${shifted.cuts.length} worth cutting, ` +
        `${proposal ? Math.round(proposal.removedMs) : 0} ms removed`,
    )
    if (proposal) return { proposal }
    // No proposal from the stored envelope is a real answer, not a failure:
    // it is the same analyser on the same statistic. Say why and stop.
    return {
      proposal: null,
      reason: shifted.reason ?? 'no silences long enough to be worth cutting',
    }
  }

  // The export's own construction, not a copy of it: F5b made the two capable
  // of disagreeing about how long a span lasts, and an envelope measured on a
  // different timeline proposes cuts in the wrong places.
  const mixers = await openAudioMixers(recording, edit, () => {})
  if (mixers.length === 0) return { proposal: null, reason: 'this take has no audio to analyse' }
  try {
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
