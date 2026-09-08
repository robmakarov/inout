/**
 * EXPERIMENTAL — J13 step 0: WHAT DOES VIDEOTOOLBOX ACTUALLY EMIT?
 *
 * The whole of "same as last frame" rests on being able to WRITE one picture
 * into a stream this machine's hardware encoder produced. Before a line of that
 * is written, this reads the stream back and answers the four questions that
 * decide how hard it is — and whether it is possible at all:
 *
 *   profile / entropy_coding_mode_flag   CABAC needs an arithmetic coder to say
 *                                        "every macroblock is skipped"; CAVLC
 *                                        needs one `ue(v)`. Same idea, two very
 *                                        different days of work.
 *   pic_order_cnt_type                   type 0 carries an explicit POC in every
 *                                        slice header, which is what an injected
 *                                        picture has to fit BETWEEN. Type 2
 *                                        derives it from frame_num and forbids
 *                                        exactly what we want to do.
 *   nal_ref_idc per packet               a non-reference injected frame does not
 *                                        advance frame_num, so the encoder's own
 *                                        numbering stays valid. That is only
 *                                        true if VT marks its own frames the way
 *                                        this expects.
 *   B-frames                             reordering would mean POC gaps are not
 *                                        free. The export asks for none; this
 *                                        checks rather than believes it.
 *
 * Nothing here modifies a stream. It reports, so the build that follows is
 * aimed at what the machine does rather than at what the spec permits.
 */
import { constantQualityCodec } from '@core/compose/constantQuality'
import {
  buildSkipSlice,
  parsePps,
  parseSliceHeader,
  parseSps,
  splitAvcC,
  type AvcPps,
  type AvcSliceHeader,
  type AvcSps,
} from '@core/compose/avcSkipPicture'

type SliceHeader = AvcSliceHeader

export interface SkipFrameProbe {
  codec: string
  width: number
  height: number
  frames: number
  /** Parsed from the avcC the encoder handed back. */
  sps: Partial<AvcSps>
  pps: Partial<AvcPps>
  /** One row per encoded packet, in decode order. */
  packets: { i: number; type: string; bytes: number; nalRefIdc: number; nalType: number; firstMbSliceType?: number }[]
  verdict: string[]
  /** Annex B elementary streams, base64 — so a decoder that is not Chrome can
   *  be asked the same question. Tiny: these are a few hundred bytes a frame. */
  annexB?: { original: string; spliced: string }
  /** REAL BYTES FROM THIS MACHINE'S ENCODER, so the unit tests that drive the
   *  ordering machine run on a stream a hardware encoder actually produced
   *  rather than on one this repo invented. Paste into avcSkipPicture.test.ts. */
  fixture?: { avcC: string; packets: { type: string; b64: string }[] }
}

export async function runSkipFrame(opts: { width?: number; height?: number; frames?: number; at?: number } = {}): Promise<SkipFrameProbe> {
  const width = opts.width ?? 960
  const height = opts.height ?? 624
  const frames = opts.frames ?? 30
  const at = opts.at ?? 10
  const verdict: string[] = []

  // The export's own codec choice, through the export's own prober, so this is
  // not a probe of some other configuration than the one that ships.
  const cq = await constantQualityCodec('avc', width, height)
  const codec = cq ?? 'avc1.640028'
  verdict.push(`constantQualityCodec picked ${codec}`)

  const packets: SkipFrameProbe['packets'] = []
  const bodies: Uint8Array[] = []
  const kinds: ('key' | 'delta')[] = []
  let description: Uint8Array | null = null

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !description) {
        const d = meta.decoderConfig.description
        description = new Uint8Array(
          d instanceof ArrayBuffer ? d.slice(0) : (d as ArrayBufferView).buffer.slice(0),
        )
      }
      const body = new Uint8Array(chunk.byteLength)
      chunk.copyTo(body)
      bodies.push(body)
      kinds.push(chunk.type as 'key' | 'delta')
      const first = body.length > 4 ? body[4] : 0
      packets.push({
        i: packets.length,
        type: chunk.type,
        bytes: chunk.byteLength,
        nalRefIdc: (first >> 5) & 3,
        nalType: first & 0x1f,
      })
    },
    error: (e) => verdict.push(`ENCODER ERROR ${String(e)}`),
  })

  encoder.configure({
    codec,
    width,
    height,
    bitrateMode: 'quantizer',
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  } as VideoEncoderConfig)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  for (let i = 0; i < frames; i++) {
    ctx.fillStyle = '#101010'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#40e0d0'
    ctx.fillRect((i * 13) % width, 100, 120, 120)
    ctx.fillStyle = '#ffffff'
    ctx.font = '48px monospace'
    ctx.fillText(String(i), 40, 400)
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 60), duration: Math.round(1e6 / 60) })
    encoder.encode(frame, { keyFrame: i === 0, avc: { quantizer: 20 } } as VideoEncoderEncodeOptions)
    frame.close()
  }
  await encoder.flush()
  encoder.close()

  if (!description) {
    verdict.push('NO avcC — the encoder returned no description; nothing can be written into this stream')
    return { codec, width, height, frames, sps: {}, pps: {}, packets, verdict }
  }

  const { sps, pps } = splitAvcC(description)
  if (!sps.length || !pps.length) {
    verdict.push('THE avcC CARRIED NO HEADERS — nothing can be read back')
    return { codec, width, height, frames, sps: {}, pps: {}, packets, verdict }
  }
  const spsParsed = parseSps(sps[0])
  const ppsParsed = parsePps(pps[0])

  // The fixture the unit tests run on: real bytes, this machine's encoder.
  const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
  const fixture = {
    avcC: b64(description),
    packets: bodies.slice(0, 4).map((b, i) => ({ type: kinds[i], b64: b64(b) })),
  }

  const cabac = ppsParsed.entropy_coding_mode_flag === true
  verdict.push(cabac ? 'CABAC — an all-skip slice needs an arithmetic coder' : 'CAVLC — an all-skip slice is one ue(v)')
  verdict.push(`pic_order_cnt_type ${spsParsed.pic_order_cnt_type}`)
  const nonRef = packets.filter((p) => p.nalRefIdc === 0).length
  verdict.push(`${nonRef} of ${packets.length} packets are non-reference`)

  // ---- read VT's own numbering back ---------------------------------------
  const headers = bodies.map((b) => parseSliceHeader(b.subarray(4), spsParsed, ppsParsed))
  const readable = headers.filter((h): h is SliceHeader => h !== null).length
  verdict.push(`slice headers parsed: ${readable}/${headers.length}`)
  const pocs = headers.map((h) => h?.pic_order_cnt_lsb ?? -1)
  const fnums = headers.map((h) => h?.frame_num ?? -1)
  verdict.push(`poc_lsb[0..6] ${pocs.slice(0, 7).join(',')} · frame_num[0..6] ${fnums.slice(0, 7).join(',')}`)

  const hAt = headers[at]
  const hNext = headers[at + 1]
  if (!hAt || !hNext) {
    verdict.push('CANNOT SPLICE — slice headers at the injection point did not parse')
    return { codec, width, height, frames, sps: spsParsed, pps: ppsParsed, packets: packets.slice(0, 8), verdict, fixture }
  }

  const pocGap = hNext.pic_order_cnt_lsb - hAt.pic_order_cnt_lsb
  verdict.push(`poc gap across the injection point: ${pocGap}`)
  if (pocGap < 2) {
    verdict.push('NO ROOM FOR A POC — the encoder numbers consecutive pictures 1 apart, so an inserted picture has no legal order value between them')
  }
  const injectedPoc = hAt.pic_order_cnt_lsb + Math.floor(pocGap / 2)

  // frame_num of a non-reference picture is the NEXT value, which is exactly
  // what the encoder's own following packet already carries.
  const skipNal = buildSkipSlice(
    spsParsed,
    ppsParsed,
    {
      frame_num: hNext.frame_num,
      slice_qp_delta: hAt.tail?.slice_qp_delta ?? 0,
      disable_deblocking_filter_idc: hAt.tail?.disable_deblocking_filter_idc ?? 0,
    },
    injectedPoc,
    hAt.marking ?? { kind: 'short', picNum: hAt.frame_num },
  )
  const skipChunk = new Uint8Array(4 + skipNal.length)
  new DataView(skipChunk.buffer).setUint32(0, skipNal.length)
  skipChunk.set(skipNal, 4)
  verdict.push(`skip picture built: ${skipChunk.length} bytes for ${((spsParsed.pic_width_in_mbs_minus1 as number) + 1) * ((spsParsed.pic_height_in_map_units_minus1 as number) + 1)} macroblocks`)

  // ---- decode both streams and compare pixels -----------------------------
  const decodeAll = async (chunks: { data: Uint8Array; type: 'key' | 'delta'; ts: number }[]): Promise<Uint8Array[]> => {
    const out: Uint8Array[] = []
    let failed: string | null = null
    const dec = new VideoDecoder({
      output: async (f) => {
        const buf = new Uint8Array(f.allocationSize({ format: 'RGBA' }))
        await f.copyTo(buf, { format: 'RGBA' })
        out.push(buf)
        f.close()
      },
      error: (e) => {
        failed = String(e)
      },
    })
    dec.configure({ codec, description, codedWidth: width, codedHeight: height } as VideoDecoderConfig)
    for (const c of chunks) {
      dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, data: c.data }))
    }
    await dec.flush().catch((e) => {
      failed = String(e)
    })
    dec.close()
    if (failed) verdict.push(`DECODER ERROR: ${failed}`)
    return out
  }

  const original = bodies.map((data, i) => ({ data, type: kinds[i], ts: Math.round((i * 1e6) / 60) }))
  const spliced: typeof original = []
  for (let i = 0; i < original.length; i++) {
    spliced.push({ ...original[i], ts: Math.round((spliced.length * 1e6) / 60) })
    if (i === at) spliced.push({ data: skipChunk, type: 'delta', ts: Math.round((spliced.length * 1e6) / 60) })
  }

  const a = await decodeAll(original)
  const b = await decodeAll(spliced)
  verdict.push(`decoded: original ${a.length} frames, spliced ${b.length} frames (expected ${a.length + 1})`)

  const same = (x: Uint8Array, y: Uint8Array): boolean => {
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  const firstDiff = (x: Uint8Array, y: Uint8Array): number => {
    let n = 0
    for (let i = 0; i < Math.min(x.length, y.length); i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++
    return n
  }

  if (b.length === a.length + 1) {
    const copyIsExact = same(b[at], b[at + 1])
    verdict.push(
      copyIsExact
        ? `THE INJECTED PICTURE IS A BIT-EXACT COPY of the frame before it (${b[at].length} bytes compared)`
        : `INJECTED PICTURE DIFFERS from the frame before it — ${firstDiff(b[at], b[at + 1])} pixels`,
    )
    let tailExact = true
    let firstBad = -1
    for (let i = at + 1; i < a.length; i++) {
      if (!same(a[i], b[i + 1])) {
        tailExact = false
        firstBad = i
        break
      }
    }
    verdict.push(
      tailExact
        ? `EVERY FRAME AFTER THE INJECTION still decodes bit-identically to the untouched stream (${a.length - at - 1} frames compared)`
        : `THE STREAM DRIFTS AFTER THE INJECTION — first difference at original frame ${firstBad} (${firstDiff(a[firstBad], b[firstBad + 1])} pixels)`,
    )
    let headExact = true
    for (let i = 0; i <= at; i++) if (!same(a[i], b[i])) headExact = false
    verdict.push(headExact ? 'frames before the injection are untouched' : 'FRAMES BEFORE THE INJECTION CHANGED — impossible unless the parse is wrong')
  }

  // ---- the same bytes as an Annex B stream, for a decoder that is not Chrome
  const START = new Uint8Array([0, 0, 0, 1])
  const toAnnexB = (chunks: { data: Uint8Array }[]): string => {
    const parts: Uint8Array[] = []
    for (const nal of [...sps, ...pps]) {
      parts.push(START, nal)
    }
    for (const c of chunks) {
      let p = 0
      while (p + 4 <= c.data.length) {
        const len = new DataView(c.data.buffer, c.data.byteOffset + p, 4).getUint32(0)
        parts.push(START, c.data.subarray(p + 4, p + 4 + len))
        p += 4 + len
      }
    }
    let total = 0
    for (const x of parts) total += x.length
    const out = new Uint8Array(total)
    let o = 0
    for (const x of parts) {
      out.set(x, o)
      o += x.length
    }
    let bin = ''
    for (let i = 0; i < out.length; i += 0x8000) {
      bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
    }
    return btoa(bin)
  }

  return {
    codec,
    width,
    height,
    frames,
    sps: spsParsed,
    pps: ppsParsed,
    packets: packets.slice(0, 8),
    verdict,
    annexB: { original: toAnnexB(original), spliced: toAnnexB(spliced) },
    fixture,
  }
}
