/**
 * Constant-quality video encoding for the export (PO 2026-08-29: "we need more
 * quality and much less size, its non editable video, movies files with much
 * better quality is twice smaller usually").
 *
 * WHY THE EXPORT IS BIG. It targets a BITRATE. `render.ts` hands the encoder a
 * number of bits per second and the encoder spends them — on a 140-minute take
 * at the 1440p step that is 14 Mbps of budget whether or not the picture needs
 * it. A movie file is smaller at better quality because it is encoded to a
 * QUALITY target: the encoder spends what the frame costs and no more, so a
 * still slide costs almost nothing and a hard cut costs a lot.
 *
 * WHY IT COULD NOT SIMPLY BE SWITCHED ON. X15(a) measured the obvious lever and
 * it is a dud: `bitrateMode: 'constant' | 'variable' | unset` produce
 * BYTE-IDENTICAL files here, on the hardware encoder and the software one both
 * — `isConfigSupported` accepts a value the encoder then ignores. The one mode
 * that IS honoured is `'quantizer'` (measured: qp14/20/26 → 959/692/511 KB on
 * identical content), and it is unreachable through the library: mediabunny's
 * `VideoEncodingAdditionalOptions.bitrateMode` is typed `'constant' |
 * 'variable'`, and quantizer mode also needs a per-frame `quantizer` in the
 * ENCODE options, which nothing in the library's path sets.
 *
 * SO THE ENCODER IS OURS FOR THIS PATH ONLY. mediabunny's `registerEncoder`
 * seam lets a `CustomVideoEncoder` take over while every other part of the
 * export — the muxer, the canvas pump, the packet accounting, the fallbacks —
 * stays exactly as it was. This is a thin wrapper around the same
 * `VideoEncoder` the library would have built, differing in two lines: the
 * config says `bitrateMode: 'quantizer'`, and each `encode` carries the QP.
 *
 * HOW IT IS SELECTED, and why there is no global state. `supports()` is handed
 * the very config mediabunny built, and `onEncoderConfig` runs first and lets
 * the caller stamp that config. So a render that wants constant quality marks
 * its own config with `QP_KEY` and no other export in the same tab can pick it
 * up — the marker travels with the object, not with a module variable. An
 * unmarked config falls straight through to the library's own encoder, so
 * every path that has not opted in is untouched, byte for byte.
 */
import { CustomVideoEncoder, EncodedPacket, registerEncoder, type VideoCodec } from 'mediabunny'

/**
 * Where the QP rides on the encoder config. A symbol and not a string key so it
 * cannot collide with a real WebCodecs field, now or when one is added.
 */
export const QP_KEY = Symbol.for('inout.constantQuality.qp')

type MarkedConfig = VideoEncoderConfig & { [QP_KEY]?: number }

/**
 * H.264 quantization parameter, 0 (lossless, enormous) to 51 (mush).
 *
 * The rungs X15(a) measured on identical content were qp14 → 959 KB, qp20 →
 * 692 KB, qp26 → 511 KB. This is deliberately at the HIGH-QUALITY end of that:
 * PO asked for more quality AND less size, and the size win at this step comes
 * from not spending 14 Mbps on frames that do not need it, not from spending
 * fewer bits on the frames that do.
 */
export const DEFAULT_QP = 20

/**
 * THE DEFAULT, and it is a measured one — see the DECISIONS entry for the
 * numbers this was set from. `null` here means "keep the bitrate target".
 */
const CQ_DEFAULT: number | null = null

/** Clamp to the range H.264 actually defines; a config outside it is a crash. */
export function clampQp(qp: number): number {
  return Math.min(51, Math.max(1, Math.round(qp)))
}

/**
 * Stamp a QP onto the config mediabunny built. Pass as `onEncoderConfig` on the
 * video source; everything else about the source stays as it was.
 */
export function markConstantQuality(qp: number) {
  return (config: VideoEncoderConfig): void => {
    ;(config as MarkedConfig)[QP_KEY] = clampQp(qp)
  }
}

/** True when a config asks for constant quality — the selection rule, shared. */
function qpOf(config: VideoEncoderConfig): number | null {
  const qp = (config as MarkedConfig)[QP_KEY]
  return typeof qp === 'number' ? qp : null
}

/**
 * AVC profiles to try, in the order the live compositor tries them and for the
 * same reason: a profile nobody can encode in HARDWARE is not a better file,
 * it is a slower one. Baseline first, High last.
 */
const AVC_CANDIDATES = ['avc1.42E01E', 'avc1.4D402A', 'avc1.640028'] as const

/**
 * The exact codec string to encode this size at in quantizer mode, or null if
 * this browser will not.
 *
 * IT RETURNS THE STRING AND THE CALLER PINS IT (`fullCodecString`), because a
 * probe of one profile says nothing about another and the first version of this
 * got exactly that wrong: it hardcoded Baseline, which this machine cannot
 * encode at 1080p AT ALL — not in quantizer mode, not in any mode — so the
 * feature reported itself unsupported on hardware that supports it fine at
 * Main and High. Probing a string the encode then might not use is the same bug
 * with a longer fuse, so the probe's answer IS the string that gets used.
 */
export async function constantQualityCodec(
  codec: VideoCodec,
  width: number,
  height: number,
): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null
  if (codec !== 'avc') return null
  for (const candidate of AVC_CANDIDATES) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: candidate,
          width,
          height,
          bitrateMode: 'quantizer',
          hardwareAcceleration,
        } as VideoEncoderConfig)
        if (support.supported === true) return candidate
      } catch {
        /* try the next rung */
      }
    }
  }
  return null
}

class ConstantQualityAvcEncoder extends CustomVideoEncoder {
  private encoder: VideoEncoder | null = null
  private qp = DEFAULT_QP

  static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
    return codec === 'avc' && qpOf(config) !== null
  }

  init(): void {
    this.qp = qpOf(this.config) ?? DEFAULT_QP
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.onPacket(EncodedPacket.fromEncodedChunk(chunk), meta)
      },
      error: (err) => {
        this.onError(err)
      },
    })
    // `bitrate` is meaningless in quantizer mode and Chrome rejects the pair on
    // some builds, so it is dropped rather than left to be ignored.
    const { bitrate, ...rest } = this.config as VideoEncoderConfig & { bitrate?: number }
    try {
      encoder.configure({ ...rest, bitrateMode: 'quantizer' } as VideoEncoderConfig)
    } catch (err) {
      // The probe said yes and configure said no. Encode the take rather than
      // fail it: this is exactly the config the library would have built.
      console.warn('[compose] quantizer mode refused at configure — bitrate target kept', err)
      this.qp = 0
      encoder.configure(this.config)
    }
    this.encoder = encoder
  }

  encode(videoSample: { toVideoFrame(): VideoFrame }, options: VideoEncoderEncodeOptions): void {
    const encoder = this.encoder
    if (!encoder) throw new Error('constant-quality encoder used before init')
    const frame = videoSample.toVideoFrame()
    try {
      // THE PER-FRAME QP IS THE WHOLE POINT. Quantizer mode without it encodes
      // at the implementation's default and the file is neither the size nor
      // the quality anyone asked for.
      encoder.encode(frame, {
        keyFrame: options.keyFrame,
        // qp 0 marks the configure-time fallback above: the encoder is on its
        // bitrate target, so asking for a quantizer would be a lie.
        ...(this.qp > 0 ? { avc: { quantizer: this.qp } } : {}),
      } as VideoEncoderEncodeOptions)
    } finally {
      frame.close()
    }
  }

  async flush(): Promise<void> {
    await this.encoder?.flush()
  }

  close(): void {
    const encoder = this.encoder
    this.encoder = null
    if (encoder && encoder.state !== 'closed') encoder.close()
  }
}

let registered = false

/** Idempotent — mediabunny refuses a double registration. */
export function registerConstantQualityEncoder(): void {
  if (registered) return
  registered = true
  registerEncoder(ConstantQualityAvcEncoder as unknown as typeof CustomVideoEncoder)
}

/**
 * Is constant quality on for this export, and at what QP?  `null` = off, keep
 * the bitrate target.
 *
 *   ?cq=off            bitrate target, the pre-2026-08-29 behaviour
 *   ?cq=1              constant quality at DEFAULT_QP
 *   ?cq=26             constant quality at an explicit QP (1-51, lower = finer)
 *   localStorage['inout.export.cq'] = 'off' | '20'   (sticky)
 *
 * ONLY THE RENDER PATH SEES THIS. An unedited export at the default step copies
 * the composite's packets and never encodes anything, so the file most users
 * get is not affected either way.
 */
const CQ_STORAGE_KEY = 'inout.export.cq'

function parseCq(raw: string | null): number | null | undefined {
  if (raw === null || raw === '') return undefined
  if (raw === 'off' || raw === '0' || raw === 'false') return null
  if (raw === 'on' || raw === '1' || raw === 'true') return DEFAULT_QP
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 && n <= 51 ? clampQp(n) : undefined
}

export function constantQualityQp(): number | null {
  let fromSearch: number | null | undefined
  if (typeof location !== 'undefined') {
    fromSearch = parseCq(new URLSearchParams(location.search).get('cq'))
  }
  if (fromSearch !== undefined) return fromSearch
  try {
    const fromStorage = parseCq(localStorage.getItem(CQ_STORAGE_KEY))
    if (fromStorage !== undefined) return fromStorage
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
  return CQ_DEFAULT
}

export function setConstantQuality(qp: number | null): void {
  try {
    localStorage.setItem(CQ_STORAGE_KEY, qp === null ? 'off' : String(clampQp(qp)))
  } catch {
    /* storage unavailable */
  }
}
