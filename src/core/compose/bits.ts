/**
 * BITS AUDIT — the render half (task O11a).
 *
 * PO 2026-08-23: "never make it worse for everyone because one system can't."
 * The precondition for any size lever is knowing where the bytes actually go,
 * and until now nobody did: the 8 Mbps ceiling in codecs.ts was picked blind.
 *
 * The capture half already counts this (CompositorStats in the v2 worker) —
 * owning the encoder makes it free. The render path does not own its encoder,
 * but mediabunny hands every encoded packet back through `onEncodedPacket`, so
 * the same numbers are one callback away: how many bytes are video vs audio,
 * what share of the video is keyframes (the GOP lever's price tag), and how
 * much of the requested bitrate the content actually needed.
 *
 * Field names match CompositorStats deliberately: the two halves of the audit
 * are meant to be read side by side.
 */

export interface RenderBits {
  videoBytes: number
  videoPackets: number
  keyframeBytes: number
  keyframeCount: number
  audioBytes: number
  audioPackets: number
  /** What we ASKED the encoder for, bits/s. */
  requestedVideoBitrate: number
  /** Keyframe cadence requested, seconds. 0 = not ours to choose (the instant
   *  path copies packets a MediaRecorder produced). */
  keyFrameIntervalSec: number
}

export interface BitsSummary extends RenderBits {
  durationSec: number
  /** What the video track actually cost, bits/s. */
  achievedVideoBitrate: number
  achievedAudioBitrate: number
  /** Achieved / requested, as a percentage — <100 % means the ceiling never bound. */
  bitrateUsePct: number
  /** Share of video bytes spent on keyframes. This is what GOP stretch buys. */
  keyframeSharePct: number
  /** Mean bytes per keyframe and per delta frame — the two numbers a GOP
   *  decision is actually made from. */
  meanKeyframeBytes: number
  meanDeltaBytes: number
}

export function emptyBits(requestedVideoBitrate: number, keyFrameIntervalSec: number): RenderBits {
  return {
    videoBytes: 0,
    videoPackets: 0,
    keyframeBytes: 0,
    keyframeCount: 0,
    audioBytes: 0,
    audioPackets: 0,
    requestedVideoBitrate,
    keyFrameIntervalSec,
  }
}

/** Counts encoded packets as they are produced. No allocation per packet. */
export class BitsAudit {
  readonly bits: RenderBits

  constructor(requestedVideoBitrate: number, keyFrameIntervalSec: number) {
    this.bits = emptyBits(requestedVideoBitrate, keyFrameIntervalSec)
  }

  video(byteLength: number, type: 'key' | 'delta'): void {
    this.bits.videoBytes += byteLength
    this.bits.videoPackets++
    if (type === 'key') {
      this.bits.keyframeBytes += byteLength
      this.bits.keyframeCount++
    }
  }

  audio(byteLength: number): void {
    this.bits.audioBytes += byteLength
    this.bits.audioPackets++
  }

  summarize(durationSec: number): BitsSummary {
    return summarizeBits(this.bits, durationSec)
  }
}

const pct = (num: number, den: number): number =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : 0

export function summarizeBits(bits: RenderBits, durationSec: number): BitsSummary {
  const sec = durationSec > 0 ? durationSec : 0
  const deltaCount = bits.videoPackets - bits.keyframeCount
  const deltaBytes = bits.videoBytes - bits.keyframeBytes
  return {
    ...bits,
    durationSec: Math.round(sec * 1000) / 1000,
    achievedVideoBitrate: sec > 0 ? Math.round((bits.videoBytes * 8) / sec) : 0,
    achievedAudioBitrate: sec > 0 ? Math.round((bits.audioBytes * 8) / sec) : 0,
    bitrateUsePct:
      sec > 0 && bits.requestedVideoBitrate > 0
        ? pct((bits.videoBytes * 8) / sec, bits.requestedVideoBitrate)
        : 0,
    keyframeSharePct: pct(bits.keyframeBytes, bits.videoBytes),
    meanKeyframeBytes: bits.keyframeCount > 0 ? Math.round(bits.keyframeBytes / bits.keyframeCount) : 0,
    meanDeltaBytes: deltaCount > 0 ? Math.round(deltaBytes / deltaCount) : 0,
  }
}

/** One console line — the same shape the capture half logs at stop. */
export function formatBits(s: BitsSummary, label: string): string {
  const mb = (b: number) => (b / 1_000_000).toFixed(2)
  const mbps = (b: number) => (b / 1_000_000).toFixed(2)
  return (
    `[bits] ${label}: video ${mb(s.videoBytes)} MB @ ${mbps(s.achievedVideoBitrate)} Mbps ` +
    `(${s.bitrateUsePct}% of the ${mbps(s.requestedVideoBitrate)} Mbps ceiling) · ` +
    `keyframes ${s.keyframeCount} = ${s.keyframeSharePct}% of video bytes ` +
    `(${s.meanKeyframeBytes} B vs ${s.meanDeltaBytes} B/delta, cadence ` +
    `${s.keyFrameIntervalSec > 0 ? `${s.keyFrameIntervalSec}s` : 'recorder-chosen'}) · ` +
    `audio ${mb(s.audioBytes)} MB @ ${mbps(s.achievedAudioBitrate)} Mbps · ${s.durationSec}s`
  )
}
