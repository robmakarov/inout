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
 * NO CEILING, AND IT IS RULED (Robert 2026-09-02, DECISIONS robert (16), Q1).
 * Quantizer mode ignores `bitrate` entirely, so a pathological source (grain,
 * confetti, dither) can cost more than the tier's old cap — measured at 2.6x on
 * one 30 s motion take. That is accepted: "if file gets to big you are just
 * going fix it other ways". Every content measured otherwise came in far under
 * (the busiest lane tested ran 3.17 Mbps at qp20 against 3.55 on the bitrate
 * target; still text 1.84 of 8), and `?cq=off` is still the way back to the
 * bitrate target. The 2026-08-30 governor that used to live here is DELETED,
 * with its cumulative-average defect; the finalize stall it was credited with
 * fixing was the encode-queue await, which stays.
 */
const CQ_DEFAULT: number | null = 20

/**
 * THE SAME DIAL, IN AV1's UNITS — task J9, 2026-09-05, and it is measured.
 *
 * WebCodecs' AV1 quantizer is 0-63 on its own curve; H.264's QP is 1-51 on
 * another. Nothing maps between them, so this was swept on the two contents
 * DEFAULT_QP was chosen on (`npm run exp -- av1q`), scored against the bitrate
 * target the 4:4:4 rung ships with today (text: 304 KB, green 99.6 %, glyph
 * fringe 3.69, 37.3 dB · motion: 345 KB, fringe 1.59, 47.5 dB):
 *
 *   q     text KB   green   fringe   dB      motion, against its own control
 *   8       501     100.9    1.61    46.6    13.38x
 *   16      419     100.7    1.80    45.7     7.78x
 *   24      367     100.4    2.04    44.5     4.53x
 *   32      329     100.2    2.16    43.7     2.86x
 *   40      301     100.0    2.60    42.3     2.22x
 *   48      278     100.0    2.85    41.3     1.73x
 *   52      268     100.0    2.99    40.8     1.43x
 *   56      260      99.8    3.11    40.3     1.27x
 *   60      252      99.8    3.24    40.0     1.08x   <- this one
 *   63      243      99.3    3.28    39.9     0.85x
 *
 * 60 IS THE RUNG THAT IS PARETO-BETTER ON BOTH CONTENTS, which is the same rule
 * that picked DEFAULT_QP: against today's bitrate target it keeps more colour
 * (99.8 vs 99.6 %), a finer glyph edge (3.24 vs 3.69 — still inside O9(b)'s own
 * shipped claim of 8.60 → 3.61) and more signal (40.0 vs 37.3 dB), for 83 % of
 * the file on text and 1.08x on motion. Nothing about the picture regresses and
 * the size does not run away.
 *
 * WHY NOT FINER, when this is the switch someone turns on to get every colour:
 * because finer costs the take rather than the frame. q32 buys 1.1 dB and pays
 * 2.86x on motion, and quantizer mode has NO byte ceiling by ruling (robert
 * (16), Q1) — a two-hour screen recording is where that lands. The ladder is
 * printed above precisely so moving this constant is one edit and no research.
 */
export const DEFAULT_AV1_QUANTIZER = 60

/** Clamp to the range H.264 actually defines; a config outside it is a crash. */
export function clampQp(qp: number): number {
  return Math.min(51, Math.max(1, Math.round(qp)))
}

/** The same, for AV1's 0-63 scale. Two codecs, two ranges, no shared clamp. */
export function clampAv1Quantizer(q: number): number {
  return Math.min(63, Math.max(0, Math.round(q)))
}

/**
 * `?cq=`'s H.264 number, in AV1's units.
 *
 * ONE ANCHOR IS MEASURED AND THE REST IS SCALED FROM IT, and that is said out
 * loud rather than implied: the dial's default (DEFAULT_QP) lands on the rung
 * the sweep above chose, and every other value rides the same ratio. It clamps
 * at 63 because AV1 has no coarser rung, so the top of the H.264 range flattens
 * — the alternative, a switch whose number the 4:4:4 rung silently ignores, is
 * the defect `?cq=` and `?sourceframe=` already cost this project once each.
 * Re-measure with `npm run exp -- av1q` before trusting a value far from 20.
 */
export function av1QuantizerFor(qp: number): number {
  return clampAv1Quantizer((qp * DEFAULT_AV1_QUANTIZER) / DEFAULT_QP)
}

/**
 * Stamp a QP onto the config mediabunny built. Pass as `onEncoderConfig` on the
 * video source; everything else about the source stays as it was.
 *
 * J9: the value is stored as given and clamped by the ENCODER at init, which is
 * the only place that knows which codec it is. Clamping to H.264's 1-51 here
 * would have silently turned the measured AV1 rung (60) into 51.
 */
export function markConstantQuality(qp: number) {
  return (config: VideoEncoderConfig): void => {
    ;(config as MarkedConfig)[QP_KEY] = Math.round(qp)
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
 * Will this machine encode THIS EXACT string in quantizer mode? (task J9)
 *
 * The ladder above walks profiles and levels because AVC's string is ours to
 * choose. O9(b)'s is not: `fullColourCodec` has already probed and PINNED the
 * 4:4:4 profile, and probing one string while encoding another is the bug that
 * made constant quality report itself unsupported on hardware that supports it.
 * So there is nothing to walk here — the string IS the request, and the only
 * question is whether quantizer mode is available for it.
 */
export async function quantizerModeAccepts(
  codecString: string,
  width: number,
  height: number,
  hardwareAcceleration: VideoEncoderConfig['hardwareAcceleration'],
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: codecString,
      width,
      height,
      bitrateMode: 'quantizer',
      hardwareAcceleration,
    } as VideoEncoderConfig)
    return support.supported === true
  } catch {
    return false
  }
}

/**
 * THERE IS NO BYTE CEILING HERE, AND THAT IS A RULING, NOT AN OVERSIGHT.
 *
 * Robert 2026-09-02 (DECISIONS robert (16)), asked whether the export needed
 * one at all: "we need or not? if file gets to big you are just going fix it
 * other ways". Quantizer mode now means what its name says — the QP stays where
 * the page put it and the size follows the content. Size is never bought by
 * silently degrading the picture mid-file; it is bought the ways that cost the
 * user nothing he did not choose: the quality slider he already owns, the codec
 * lane, single generation, the screen-content work, and the disk guard — the
 * only honest ceiling, because it measures real storage instead of a typed
 * constant. Consequence he accepted: motion-heavy exports get bigger and render
 * slower. NOBODY PUTS A REPLACEMENT CEILING IN THIS FILE without him saying so.
 *
 * What is NOT deleted, because it was a different bug with the same symptom:
 * the dequeue await in `encode()` below. That, not the byte count, is what made
 * finalize 9,164 ms.
 */

/**
 * How many frames may sit inside the VideoEncoder before the render is made to
 * wait. Four is mediabunny's own number for its own encoder, and matching it
 * keeps the two paths behaving alike rather than inventing a second answer.
 */
const ENCODE_QUEUE_DEPTH = 4

/**
 * The codecs this encoder drives. AVC since 2026-08-29; AV1 since J9, because
 * O9(b)'s 4:4:4 rung was the last encode in the product still on a bitrate.
 * Every other family falls through to mediabunny's own encoder untouched.
 */
const QUANTIZER_CODECS = new Set<VideoCodec>(['avc', 'av1'])

class ConstantQualityEncoder extends CustomVideoEncoder {
  private encoder: VideoEncoder | null = null
  /** Set once from the config and never moved again — see the ruling above. */
  private qp = DEFAULT_QP

  static supports(codec: VideoCodec, config: VideoEncoderConfig): boolean {
    return QUANTIZER_CODECS.has(codec) && qpOf(config) !== null
  }

  init(): void {
    // THE CLAMP IS PER CODEC and it happens here, the only place that knows
    // which one this is: H.264 defines 1-51 and AV1 0-63, and a config outside
    // its own range is a crash rather than a coarse picture.
    const asked = qpOf(this.config)
    this.qp =
      asked === null
        ? this.codec === 'av1'
          ? DEFAULT_AV1_QUANTIZER
          : DEFAULT_QP
        : this.codec === 'av1'
          ? clampAv1Quantizer(asked)
          : clampQp(asked)
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
        //
        // THE KEY IS THE CODEC'S OWN and getting it wrong is SILENT — an `avc`
        // key on an AV1 encoder is ignored, the frame encodes at the
        // implementation's default, and the file is neither the size nor the
        // quality anyone asked for with no error anywhere.
        ...(this.qp > 0
          ? this.codec === 'av1'
            ? { av1: { quantizer: this.qp } }
            : { avc: { quantizer: this.qp } }
          : {}),
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
  registerEncoder(ConstantQualityEncoder as unknown as typeof CustomVideoEncoder)
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
