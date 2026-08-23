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

export interface CertifiedExport {
  app: 'inout'
  v: 1
  path: 'instant' | 'render'
  output: { width: number; height: number; fps?: number; videoBitrate?: number }
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
