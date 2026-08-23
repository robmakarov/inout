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
import { blobStore } from '@core/store'
import type { EditState, Recording } from '@core/types'
import {
  SILENCE_DEFAULTS,
  analyzeEnvelope,
  proposeTightening,
  type SilenceParams,
  type TightenProposal,
} from '@core/timeline/silence'
import { keptSegments } from '@core/timeline'
import { measureMixEnvelope, mixGainForChannels, openAudioChannel, type AudioChannelMixer } from './audio'
import { AUDIO_SAMPLE_RATE } from './codecs'

export interface TightenResult {
  proposal: TightenProposal | null
  /** Why there is nothing to propose, when there isn't. */
  reason?: string
}

/**
 * Mixers over the CURRENT edit, one per (audio channel × kept span) — the same
 * construction pipeline.ts uses, kept local so the render path is untouched.
 */
async function openMixers(recording: Recording, edit: EditState): Promise<AudioChannelMixer[]> {
  const mixers: AudioChannelMixer[] = []
  const segments = keptSegments(edit)
  for (const channel of recording.channels) {
    if (channel.media !== 'audio') continue
    const ce = edit.channels.find((c) => c.channelId === channel.id)
    if (!ce || !ce.enabled) continue
    const localStartMs = Math.max(0, ce.trimStartMs)
    const localEndMs = Math.min(channel.durationMs, ce.trimEndMs)
    const recStart = channel.startOffsetMs + localStartMs
    const recEnd = channel.startOffsetMs + localEndMs
    let cursor = 0
    for (const seg of segments) {
      const segLen = Math.max(0, seg.endMs - seg.startMs)
      const from = Math.max(recStart, seg.startMs)
      const to = Math.min(recEnd, seg.endMs)
      if (to > from) {
        const blob = await blobStore.read(channel.blobKey)
        const mixer = await openAudioChannel(
          blob,
          channel.id,
          (cursor + (from - seg.startMs)) / 1000,
          (cursor + (to - seg.startMs)) / 1000,
          (seg.startMs - cursor - channel.startOffsetMs) / 1000,
        )
        if (mixer) mixers.push(mixer)
      }
      cursor += segLen
    }
  }
  return mixers
}

export async function analyzeSilence(
  recording: Recording,
  edit: EditState,
  params: SilenceParams = SILENCE_DEFAULTS,
): Promise<TightenResult> {
  const mixers = await openMixers(recording, edit)
  if (mixers.length === 0) return { proposal: null, reason: 'this take has no audio to analyse' }
  try {
    const outputMs = keptSegments(edit).reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
    const totalAudioFrames = Math.round((outputMs / 1000) * AUDIO_SAMPLE_RATE)
    // The same base gain the export applies, so the envelope is the mix's, not
    // one channel's — a threshold measured at a different gain is a different
    // threshold.
    const gain = mixers.length > 1 ? mixGainForChannels(mixers.length) : 1
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
