/**
 * WHICH FILE THE PACKET-COPYING PATHS COPY — one decision, shared (task O3b).
 *
 * Both fast paths exist because some file on disk already holds exactly the
 * pixels the output wants, so the export can move bytes instead of decoding
 * and re-encoding them. Until O3b that file was always the live composite.
 * It does not have to be: when a take has exactly ONE video channel and that
 * channel is already AVC in fragmented MP4 at exactly the export geometry, the
 * compositor's contain-fit into its own 1920x1080 canvas is the identity — so
 * the composite is a SECOND ENCODE OF A PICTURE WE ALREADY HAVE, and copying
 * the raw channel is strictly less work for a strictly better picture.
 *
 * "Strictly better" is measured, not argued (X15(d), and R1 controlled the
 * attribution): against the canvas the source actually painted, the raw screen
 * channel keeps 80.0 % of the source's green and 89.1 % of its blue; the
 * composite keeps 70.3 / 75.2; and the unedited export is the composite byte
 * for byte. One 4:2:0 generation instead of two.
 *
 * THIS FILE IS PURE AND THAT IS THE POINT. Choosing the copy source is the
 * whole of O3b's correctness argument — a wrong "yes" here ships a file of the
 * wrong geometry or the wrong codec — so it is a function of the recording and
 * the requested settings, with the reasons it said no returned alongside the
 * answer, and it is unit-tested rather than reasoned about.
 */
import type { CompositeRecording, ChannelRecording, ExportSettings, Recording } from '@core/types'
import { DEFAULT_EXPORT_SETTINGS } from '@core/types'
import { singleGenExportEnabled } from '@core/singleGen'

export type CopyOrigin = 'composite' | 'single-generation'

/**
 * A file the export may copy packets out of, and everything the copy paths
 * need to know about it. Deliberately the intersection of what a
 * CompositeRecording and a ChannelRecording can both say.
 */
export interface CopySource {
  origin: CopyOrigin
  blobKey: string
  mimeType: string
  width: number
  height: number
  durationMs: number
  /**
   * Where this file's zero sits on the RECORDING timeline, ms. The composite
   * has its own clock (P0-instant-sync) and so does a raw channel; both
   * declare it the same way, and both copy paths convert through
   * compose/compositeTime.ts rather than assuming.
   */
  startOffsetMs: number
  /**
   * Which encoder wrote it. A BOUNDARY SPLICE NEEDS AN ENCODER WE OWN: smart
   * cut re-encodes the frames between a cut and the next keyframe and then
   * requires its own avcC to match the copied packets' byte for byte, which is
   * only reachable when both came from a WebCodecs VideoEncoder we configured.
   * MediaRecorder's is not ours to reproduce.
   */
  writer: 'mediarecorder' | 'webcodecs'
  /**
   * The encoder was still behind when capture stopped, so this file is missing
   * an unknown amount of its end (P0-tail). Copying it would ship a take that
   * ends early.
   */
  tailIncomplete: boolean
  /** Set when origin is single-generation — evidence, not behaviour. */
  channelId?: string
}

export interface CopySourceChoice {
  /** Null means no packet copy is possible; the caller renders. */
  source: CopySource | null
  /**
   * Why each candidate was refused, in the order they were tried. Evidence for
   * the rigs and the console, never a string a user reads.
   */
  declined: { origin: CopyOrigin; reason: string }[]
}

/** The measured-video container (capture/measuredVideo.ts's MEASURED_VIDEO_MIME). */
function isMp4Channel(channel: ChannelRecording): boolean {
  return channel.mimeType.startsWith('video/mp4')
}

function compositeSource(composite: CompositeRecording): CopySource {
  return {
    origin: 'composite',
    blobKey: composite.blobKey,
    mimeType: composite.mimeType,
    width: composite.width,
    height: composite.height,
    durationMs: composite.durationMs,
    startOffsetMs: composite.startOffsetMs ?? 0,
    writer: composite.engine === 'v1' ? 'mediarecorder' : 'webcodecs',
    tailIncomplete: composite.tailIncomplete === true,
  }
}

/**
 * The take's video channels. A take with none cannot be copied at all, and a
 * take with two or more needs the compositor to combine them — which is the
 * whole reason the composite exists.
 */
function videoChannels(recording: Recording): ChannelRecording[] {
  return recording.channels.filter((c) => c.media === 'video')
}

/**
 * Does one raw channel already hold the default composition?
 *
 * EVERY CONDITION HERE IS A WAY THE COPY WOULD BE WRONG, not a preference:
 *  · more than one video channel — the composite is doing real work;
 *  · not mp4 — the raw channel is MediaRecorder's VP8/VP9 webm, which is not
 *    the shape the MP4 muxer copies into (this is exactly what O3b waited on
 *    for months, and what X6 delivered);
 *  · dimensions that are not the export's — the compositor CONTAIN-fits into
 *    its own canvas, so at any other size it is resampling, and copying the raw
 *    channel would hand the user a file of a different geometry than the one
 *    the product promises;
 *  · a zero-length channel — nothing to copy.
 */
export function singleGenerationSource(
  recording: Recording,
  settings: Pick<ExportSettings, 'width' | 'height'>,
): { source: CopySource | null; reason: string } {
  const video = videoChannels(recording)
  if (video.length !== 1) {
    return {
      source: null,
      reason:
        video.length === 0
          ? 'the take has no video channel'
          : `the take has ${video.length} video channels — the composite is combining them`,
    }
  }
  const channel = video[0]!
  if (!isMp4Channel(channel)) {
    return {
      source: null,
      reason: `the raw ${channel.kind} channel is ${channel.mimeType}, not mp4 — nothing to copy into an MP4 track`,
    }
  }
  if (!channel.width || !channel.height) {
    return { source: null, reason: `the raw ${channel.kind} channel did not record its dimensions` }
  }
  if (channel.width !== settings.width || channel.height !== settings.height) {
    return {
      source: null,
      reason: `the raw ${channel.kind} channel is ${channel.width}x${channel.height}, and the output is ${settings.width}x${settings.height} — the compositor's fit is not the identity`,
    }
  }
  if (channel.durationMs <= 0) {
    return { source: null, reason: `the raw ${channel.kind} channel is empty` }
  }
  return {
    source: {
      origin: 'single-generation',
      blobKey: channel.blobKey,
      mimeType: channel.mimeType,
      width: channel.width,
      height: channel.height,
      durationMs: channel.durationMs,
      startOffsetMs: channel.startOffsetMs,
      // The measured-video path is a VideoEncoder we configure and flush
      // ourselves (capture/rawVideo.worker.ts), which is what makes a boundary
      // splice possible — and its stop is a real flush(), so there is no
      // starve-and-probe tail to be incomplete (P0-tail-raw).
      writer: 'webcodecs',
      tailIncomplete: false,
      channelId: channel.id,
    },
    reason: '',
  }
}

/**
 * The copy source for this take, single generation first.
 *
 * ORDER IS THE WHOLE POLICY: when a take qualifies for single generation the
 * raw channel is preferred over the composite, because it is the same picture
 * one encode earlier. When it does not, the composite is used exactly as it
 * always was — this function can only ever ADD a copyable case, never remove
 * one, which is why it is safe to have on by default.
 *
 * O3c: SINGLE GENERATION IS TRIED AGAINST WHATEVER `settings` ASKS FOR, not
 * against a 1080p constant — a native-res 1440p screen exporting at the 1440p
 * step already holds exactly the requested pixels, and re-rendering them was
 * the day-one interaction that cancelled O3b's win. The COMPOSITE stays fenced
 * by `allowComposite`: it exists at exactly one geometry, and the caller (who
 * owns the tier ladder) is the one who knows whether the request is it.
 *
 * F13 ADDS THE SECOND HALF OF THAT FENCE, and it is not belt-and-braces — it is
 * a case that got real. Until F13 the composite was ALWAYS 1920x1080, so
 * `allowComposite` (i.e. "this is the default tier") implied "the request is
 * the composite's geometry" and a geometry check here could only ever refuse
 * something that worked. Now the composite is written at the take's own shape,
 * and a take RECORDED with the frame following the source and EXPORTED without
 * it breaks that implication: measured live on prod, a 4:3 camera take exported
 * at "1080p" with `?sourceframe=0` handed back a 1920x1440 file while the panel
 * said 1080p and the stage showed the 16:9 crop. So the composite is now
 * checked against the request as well. Every take made before F13 has a
 * 1920x1080 composite and a 1920x1080 default step, so this refuses nothing
 * that ever worked; what it refuses is the export that lied.
 */
export function chooseCopySource(
  recording: Recording,
  settings: Pick<ExportSettings, 'width' | 'height'> = DEFAULT_EXPORT_SETTINGS,
  opts: { allowComposite?: boolean } = {},
): CopySourceChoice {
  const allowComposite = opts.allowComposite ?? true
  const declined: { origin: CopyOrigin; reason: string }[] = []

  if (singleGenExportEnabled()) {
    const single = singleGenerationSource(recording, settings)
    if (single.source) return { source: single.source, declined }
    declined.push({ origin: 'single-generation', reason: single.reason })
  } else {
    declined.push({ origin: 'single-generation', reason: 'disabled by flag (?singlegen=off)' })
  }

  const composite = recording.composite
  if (!composite) {
    declined.push({ origin: 'composite', reason: 'the take has no composite' })
    return { source: null, declined }
  }
  const wrongShape =
    composite.width !== settings.width || composite.height !== settings.height
  if (!allowComposite || wrongShape) {
    declined.push({
      origin: 'composite',
      reason:
        `the composite is ${composite.width}x${composite.height} and the requested output is ` +
        `${settings.width}x${settings.height} — a different picture, only the render can make it`,
    })
    return { source: null, declined }
  }
  return { source: compositeSource(composite), declined }
}
