/**
 * Certified-export metadata (task O8, PO-approved 2026-08-22).
 *
 * Every exported file carries a short, honest record of how it was made: which
 * path produced it, the output settings, what the loudness normalizer actually
 * did, and anything the capture already knew was wrong (a frozen source, a
 * missing device). It is written into the container's comment tag, so any tool
 * can read it back and the claim travels with the file.
 *
 * `syncBoundMs` is the band this build's CI enforces on measured A/V offset —
 * an engineering guarantee, labelled as one, not a per-file measurement.
 */
import type { ExportSettings, Recording } from '@core/types'

/** Kept in step with scripts/oracle-gate.mjs MAX_SYNC_ABS_SYMMETRIC_MS. */
export const CERTIFIED_SYNC_BOUND_MS = 90

/**
 * Which rung of the codec ladder produced this file (task O11a/O11d).
 *
 * The ladder is invisible to the user by design — it is probed per browser and
 * never a setting — so the file itself has to say which rung ran, or a size or
 * playback report from the field is unattributable.
 */
export interface CertifiedCodec {
  /** Container mime, e.g. video/mp4. */
  container: string
  video: string
  audio?: string
  /** Keyframe cadence in seconds, where we control it (render path). */
  gopSec?: number
  /** Ladder rung name (O5d): 'avc' is the blind-share floor; anything above it
   *  only ever runs where the recipient is known. */
  rung?: string
}

export interface CertifiedExport {
  app: 'inout'
  v: 1
  path: 'instant' | 'render'
  output: { width: number; height: number; fps?: number; videoBitrate?: number }
  codec?: CertifiedCodec
  audio: {
    channels: number
    /** Makeup gain the loudness normalizer applied (1 = untouched). */
    makeup?: number
    loudRms?: number
    peak?: number
    /** True when the stats came from capture rather than a decode pass. */
    fromCaptureStats?: boolean
  }
  capture: { stalled?: string[]; missing?: string[]; cuts?: number }
  syncBoundMs: number
}

export function buildCertification(args: {
  recording: Recording
  path: 'instant' | 'render'
  settings: Pick<ExportSettings, 'width' | 'height'> & Partial<ExportSettings>
  audioChannels: number
  makeup?: number
  loudRms?: number
  peak?: number
  fromCaptureStats?: boolean
  cuts?: number
  codec?: CertifiedCodec
}): CertifiedExport {
  const { recording } = args
  return {
    app: 'inout',
    v: 1,
    path: args.path,
    output: {
      width: args.settings.width,
      height: args.settings.height,
      fps: args.settings.fps,
      videoBitrate: args.settings.videoBitrate,
    },
    codec: args.codec,
    audio: {
      channels: args.audioChannels,
      makeup: args.makeup === undefined ? undefined : Math.round(args.makeup * 1000) / 1000,
      loudRms: args.loudRms === undefined ? undefined : Math.round(args.loudRms * 1e5) / 1e5,
      peak: args.peak === undefined ? undefined : Math.round(args.peak * 1e4) / 1e4,
      fromCaptureStats: args.fromCaptureStats,
    },
    capture: {
      stalled: recording.stalled?.length ? recording.stalled : undefined,
      missing: recording.missing?.length ? recording.missing : undefined,
      cuts: args.cuts && args.cuts > 0 ? args.cuts : undefined,
    },
    syncBoundMs: CERTIFIED_SYNC_BOUND_MS,
  }
}

export function certificationComment(c: CertifiedExport): string {
  return JSON.stringify(c)
}

/** Parse a certification back out of a file's comment tag, if present. */
export function readCertification(comment: string | undefined | null): CertifiedExport | null {
  if (!comment) return null
  try {
    const parsed: unknown = JSON.parse(comment)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { app?: unknown }).app === 'inout'
    ) {
      return parsed as CertifiedExport
    }
  } catch {
    /* not ours */
  }
  return null
}
