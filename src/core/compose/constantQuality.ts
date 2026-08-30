/**
 * Constant-quality video encoding for the export (Robert 2026-08-29: "we need more
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
 * Robert asked for more quality AND less size, and the size win at this step comes
 * from not spending 14 Mbps on frames that do not need it, not from spending
 * fewer bits on the frames that do.
 */
export const DEFAULT_QP = 20

/**
 * THE DEFAULT, AND IT IS A MEASURED ONE. `null` would mean "keep the bitrate
 * target"; 20 is where the measurement landed.
 *
 * Measured 2026-08-29 on the deployed build at 2560x1440 (Robert's own step), 48
 * frames, PSNR of the DECODED file against the very frames that made it, on
 * two contents this product is actually for — a document sitting still with a
 * blinking caret, and the same page scrolling:
 *
 *              static                        scroll
 *   bitrate    365,967 B   49.69 dB          426,535 B   50.97 dB
 *   qp18       -4.9 %      +2.29 dB          -4.4 %      +1.73 dB
 *   qp20       -11.6 %     +0.52 dB          -11.1 %     +0.03 dB
 *   qp23       -21.4 %     -2.23 dB          -19.9 %     -2.38 dB
 *   qp26       -30.3 %     -4.85 dB          -28.9 %     -4.97 dB
 *
 * 20 is the rung that is PARETO-BETTER on both contents — never worse than the
 * bitrate target on quality, always about 11 % smaller. 23 and 26 are cheaper
 * still but pay real quality for it, which is not what was asked for. 18 is
 * also Pareto-better and buys 2 dB for half the saving; 20 was chosen because
 * Robert asked for size first.
 *
 * BE HONEST ABOUT THE SIZE OF THIS WIN: it is ~11 %, not the "twice smaller"
 * Robert compared against. The rest of that gap is not rate control — on this
 * content the bitrate target was ALREADY undershooting (1.83 of 14 Mbps), so
 * there was never 14 Mbps of waste to reclaim. What makes a movie file half
 * the size at better quality is the CODEC: hevc/av1 against our avc floor. The
 * ladder has those rungs and they are off for a distribution reason, not a
 * technical one (a blind-shared file must play for a recipient we cannot
 * probe) — that trade is Robert's and worth re-pricing at two-hour takes.
 *
 * NO CEILING. Quantizer mode ignores `bitrate` entirely, so a pathological
 * source (grain, confetti, dither) can in principle cost more than the tier's
 * old cap. Every content measured came in far under it — the busiest lane
 * tested ran 3.17 Mbps at qp20 against 3.55 on the bitrate target — but the
 * guarantee is gone, and `?cq=off` is the way back.
 */
const CQ_DEFAULT: number | null = 20

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
const AVC_PROFILES = ['42E0', '4D40', '6400'] as const

/**
 * AVC levels, ascending — 3.0 through 5.2.
 *
 * THE LEVEL IS PART OF THE ANSWER AND CANNOT BE A CONSTANT, which cost this
 * feature a whole round: the first list here was `avc1.42E01E / 4D402A /
 * 640028`, i.e. levels 3.0, 4.2 and 4.0, and a level caps the frame SIZE.
 * Measured on prod, `isConfigSupported` enforces it: at 2560x1440 only levels
 * 5.0-5.2 are accepted at all, so constant quality would have reported itself
 * unsupported at exactly the 1440p step Robert exports from — the one step this
 * whole feature exists for. Ascending, so the file gets the LOWEST level that
 * fits, which is the one the most decoders will play.
 */
const AVC_LEVELS = ['1e', '1f', '28', '29', '2a', '32', '33', '34'] as const

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
  for (const profile of AVC_PROFILES) {
    for (const level of AVC_LEVELS) {
      const candidate = `avc1.${profile}${level}`
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
  }
  return null
}

/**
 * How far the governor may give back quality before it stops. 32 is still a
 * watchable picture; past it the file would be small and worthless, and a
 * source that cannot fit its tier at 32 is telling us the tier is wrong, not
 * that the picture should be destroyed.
 */
const MAX_GOVERNED_QP = 32

/**
 * How many frames may sit inside the VideoEncoder before the render is made to
 * wait. Four is mediabunny's own number for its own encoder, and matching it
 * keeps the two paths behaving alike rather than inventing a second answer.
 */
const ENCODE_QUEUE_DEPTH = 4

class ConstantQualityAvcEncoder extends CustomVideoEncoder {
  private encoder: VideoEncoder | null = null
  private qp = DEFAULT_QP
  /** What the page asked for. The governor never goes finer than this. */
  private targetQp = DEFAULT_QP
  /** The tier's promise, in bytes per second. null = nothing to bound against. */
  private bytesPerSecCeiling: number | null = null
  private bytesOut = 0
  private firstTimestampUs: number | null = null

  static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
    return codec === 'avc' && qpOf(config) !== null
  }

  init(): void {
    this.qp = qpOf(this.config) ?? DEFAULT_QP
    this.targetQp = this.qp
    // THE CEILING, KEPT RATHER THAN DISCARDED. `bitrate` cannot be handed to a
    // quantizer-mode encoder, but it is still the number the tier promised —
    // and dropping it is what left this path unbounded. See `spend()`.
    const ceiling = (this.config as VideoEncoderConfig & { bitrate?: number }).bitrate
    this.bytesPerSecCeiling = ceiling && ceiling > 0 ? ceiling / 8 : null
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.spend(chunk.byteLength, chunk.timestamp)
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

  /**
   * THE BUG THIS METHOD HAD, AND IT WAS THE BLOCKER UNDER R2.
   *
   * mediabunny's OWN encoder waits before handing over another frame:
   *
   *     if (this.encoder.encodeQueueSize >= 4)
   *       await new Promise(r => this.encoder.addEventListener('dequeue', r, {once: true}))
   *
   * This one did not. It accepted every frame the render offered, synchronously,
   * for the whole take. mediabunny bounds its calls INTO a custom encoder at
   * four — but that counts calls to this method, and this method used to return
   * the instant `encoder.encode()` was called, so the counter fell straight back
   * to zero while the REAL queue kept growing. On a four-minute 60 fps take that
   * is fourteen thousand frames queued inside one VideoEncoder, each one holding
   * a GPU-backed VideoFrame.
   *
   * That is where the gigabyte went, and macOS's answer to it is
   * `GPU process exited unexpectedly: exit_code=9` — SIGKILL, the kernel
   * reclaiming memory — which reaches the tab as "decoding error" and reaches
   * Robert as the Chrome header vanishing and the machine locking up.
   *
   * It is also the "stuck at 95 % finalizing": nothing was ever waited for
   * during the render, so the ENTIRE backlog drained in flush(). Measured on one
   * 30 s take at the 1080p step, finalize was 9,164 ms here against 70 ms on
   * mediabunny's encoder — and shrinking the FILE by 42 % moved it to 9,258 ms,
   * i.e. not at all, which is what proved the cost was the queue and not the
   * bytes.
   *
   * Awaiting the dequeue costs nothing when the encoder is keeping up.
   */
  async encode(
    videoSample: { toVideoFrame(): VideoFrame },
    options: VideoEncoderEncodeOptions,
  ): Promise<void> {
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
    // The frame is handed over and closed above, so this waits on the ENCODER,
    // holding nothing of its own. Same depth mediabunny uses for its own.
    while (encoder.state === 'configured' && encoder.encodeQueueSize >= ENCODE_QUEUE_DEPTH) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true })
      })
    }
  }

  /**
   * THE CEILING THE QUANTIZER PATH LOST, PUT BACK.
   *
   * Quantizer mode ignores `bitrate` entirely — this file said so from the day
   * it was written ("NO CEILING ... a pathological source can in principle cost
   * more than the tier's old cap") and treated it as a theoretical risk because
   * every content measured came in under. It is not theoretical. Measured
   * 2026-08-30 on one 30 s take at the 1080p step: 36.9 MB at QP 20 against
   * 14.3 MB on the tier's bitrate target — 2.6x — and because FINALIZE IS
   * PROPORTIONAL TO OUTPUT SIZE, the same export spent 9,164 ms finalizing
   * against 70 ms. That is Robert's "all export took fucking long on 95%
   * finilizing shit", and his "file size is fucking huge", from one cause.
   *
   * (It had been invisible because `?cq=off` could not reach the render at all:
   * the export runs in a worker, which has no localStorage and does not see the
   * page's URL. Fixed in the same change.)
   *
   * So the QP now FLOATS between the target and a bounded floor of quality,
   * driven by what the file has actually cost so far. Under the ceiling it sits
   * exactly where it was — a still slide still costs almost nothing, which is
   * the whole point of quantizer mode and is untouched here. Over the ceiling
   * it gives back quality one step at a time rather than writing an unbounded
   * file. It never goes finer than the target, so this can only ever make a
   * file smaller than it is today, never bigger.
   */
  private spend(bytes: number, timestampUs: number): void {
    this.bytesOut += bytes
    // The first packet establishes the origin — and `null` rather than 0,
    // because a take legitimately starts at timestamp 0 and a sentinel that
    // collides with real data is how an off-by-one becomes a wrong ceiling.
    if (this.firstTimestampUs === null) this.firstTimestampUs = timestampUs
    if (this.bytesPerSecCeiling === null) return
    // Measured against the OUTPUT's own clock, so a render that runs slower or
    // faster than real time governs identically.
    const elapsedSec = Math.max(0.5, (timestampUs - this.firstTimestampUs) / 1_000_000)
    const spentPerSec = this.bytesOut / elapsedSec
    const over = spentPerSec / this.bytesPerSecCeiling
    if (over > 1.15 && this.qp < MAX_GOVERNED_QP) this.qp = clampQp(this.qp + 1)
    else if (over < 0.85 && this.qp > this.targetQp) this.qp = clampQp(this.qp - 1)
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

/**
 * Module-level override, so the export WORKER can be told what the page chose —
 * the same seam loudnessMode.ts already has, and for the same reason.
 *
 * WITHOUT IT THIS SWITCH DID NOTHING ON THE PATH THAT SHIPS. The render moved
 * into a worker (O5a), and a worker has no `localStorage` at all and a
 * `location` that is its own script URL — so `?cq=off`, and the sticky setting
 * beside it, were read on a thread that does not render, while the worker fell
 * through to CQ_DEFAULT every single time. Found 2026-08-30 by an A/B whose two
 * lanes came back byte-identical: a lever that changes nothing is either
 * measuring the wrong thing or is not connected, and this one was not
 * connected.
 */
let forcedQp: number | null | undefined
export function setConstantQualityOverride(qp: number | null | undefined): void {
  forcedQp = qp
}

export function constantQualityQp(): number | null {
  if (forcedQp !== undefined) return forcedQp
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
