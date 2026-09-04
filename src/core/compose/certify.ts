/**
 * Certified-export metadata (task O8, Robert-approved 2026-08-22).
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
import { noiseGateActive } from './gateFlag'

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
  /**
   * H.264 quantizer this file was encoded at, when the render targeted a
   * QUALITY instead of a bitrate (Robert 2026-08-29). Absent means the bitrate
   * target — which is what every file before this, and every packet-copied
   * file since, was made with. A size report from the field cannot be read
   * without knowing which of the two produced the file.
   */
  qp?: number
}

export interface CertifiedExport {
  app: 'inout'
  v: 1
  path: 'instant' | 'render'
  /**
   * WHICH FILE THE COPYING PATHS COPIED (task O3b). Absent means the composite,
   * which is what every file before O3b copied and what most still do.
   * 'single-generation' means the take had one video channel already at the
   * export geometry, so the export copied THAT and the composite's second
   * 4:2:0 generation never touched the picture. Two files of the same take can
   * differ visibly on coloured text depending on this, so the file says which.
   */
  copiedFrom?: 'composite' | 'single-generation'
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
    /**
     * O10c — TRUE WHEN THE NOISE GATE MADE THIS FILE. Absent means it did not,
     * which is every file before it existed and every file since, by default.
     *
     * It is here for the same reason `capture.gaveUp` is: a shared file has
     * left the recording behind, and "this sound was processed" is not
     * something a listener can hear reliably or a session should have to infer.
     * A/B pairs are judged by ear, and an ear needs to know which is which.
     */
    noiseGate?: true
  }
  capture: {
    stalled?: string[]
    missing?: string[]
    cuts?: number
    /**
     * M1 — WHAT THE TAKE GAVE UP, IN THE FILE ITSELF.
     *
     * The take's full ledger lives in `stopStats.decisions`, which travels with
     * the RECORDING; a file that is shared has left that behind. So the
     * certification carries the shed list: what moved, who decided it, and when
     * — bounded, because this string is embedded in every export.
     *
     * Absent on every take that gave nothing up, which is most of them, and on
     * every take made before M1.
     */
    gaveUp?: { atMs: number; what: string; by: string }[]
    /** Sheds beyond the ones listed — "there were more" is a different fact
     *  from "there were none". */
    gaveUpMore?: number
  }
  syncBoundMs: number
}

/** How many sheds the certification carries. A take that hunted for an hour
 *  must not put a kilobyte of ledger in every file it exports. */
const CERTIFIED_SHEDS = 12

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
  copiedFrom?: 'composite' | 'single-generation'
}): CertifiedExport {
  const { recording } = args
  return {
    app: 'inout',
    v: 1,
    path: args.path,
    copiedFrom: args.copiedFrom,
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
      ...(noiseGateActive() ? { noiseGate: true as const } : null),
    },
    capture: {
      stalled: recording.stalled?.length ? recording.stalled : undefined,
      missing: recording.missing?.length ? recording.missing : undefined,
      cuts: args.cuts && args.cuts > 0 ? args.cuts : undefined,
      ...gaveUpFrom(recording),
    },
    syncBoundMs: CERTIFIED_SYNC_BOUND_MS,
  }
}

/**
 * The take's applied sheds, compressed for the file. Only what was APPLIED and
 * only what was given UP: a restore is the take getting better, and a refusal
 * is not something the file is missing.
 */
function gaveUpFrom(recording: Recording): {
  gaveUp?: { atMs: number; what: string; by: string }[]
  gaveUpMore?: number
} {
  const sheds = (recording.stopStats?.decisions ?? []).filter(
    (d) => d.action === 'shed' && d.outcome === 'applied',
  )
  if (!sheds.length) return {}
  const kept = sheds.slice(0, CERTIFIED_SHEDS)
  return {
    gaveUp: kept.map((d) => ({ atMs: Math.round(d.atMs), what: d.what, by: d.decidedBy })),
    ...(sheds.length > kept.length ? { gaveUpMore: sheds.length - kept.length } : null),
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
