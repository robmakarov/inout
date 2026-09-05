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

export interface SkipFrameProbe {
  codec: string
  width: number
  height: number
  frames: number
  /** Parsed from the avcC the encoder handed back. */
  sps: Record<string, number | boolean | string>
  pps: Record<string, number | boolean>
  /** One row per encoded packet, in decode order. */
  packets: { i: number; type: string; bytes: number; nalRefIdc: number; nalType: number; firstMbSliceType?: number }[]
  verdict: string[]
  /** Annex B elementary streams, base64 — so a decoder that is not Chrome can
   *  be asked the same question. Tiny: these are a few hundred bytes a frame. */
  annexB?: { original: string; spliced: string }
}

/** Minimal RBSP bit reader — Annex B emulation-prevention bytes removed. */
class BitReader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}
  static unescape(nal: Uint8Array): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < nal.length; i++) {
      if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) continue
      out.push(nal[i])
    }
    return new Uint8Array(out)
  }
  u(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3]
      const bit = (byte >> (7 - (this.pos & 7))) & 1
      v = (v << 1) | bit
      this.pos++
    }
    return v >>> 0
  }
  ue(): number {
    let zeros = 0
    while (this.u(1) === 0 && zeros < 32) zeros++
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros)
  }
  se(): number {
    const k = this.ue()
    return k & 1 ? (k + 1) >> 1 : -(k >> 1)
  }
  flag(): boolean {
    return this.u(1) === 1
  }
}

function parseSps(nal: Uint8Array): Record<string, number | boolean | string> {
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const out: Record<string, number | boolean | string> = {}
  const profile_idc = r.u(8)
  out.profile_idc = profile_idc
  out.constraint_flags = r.u(8)
  out.level_idc = r.u(8)
  out.seq_parameter_set_id = r.ue()
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile_idc)) {
    const chroma = r.ue()
    out.chroma_format_idc = chroma
    if (chroma === 3) out.separate_colour_plane_flag = r.flag()
    out.bit_depth_luma_minus8 = r.ue()
    out.bit_depth_chroma_minus8 = r.ue()
    out.qpprime_y_zero_transform_bypass_flag = r.flag()
    const seqScaling = r.flag()
    out.seq_scaling_matrix_present_flag = seqScaling
    if (seqScaling) return { ...out, PARSE_STOPPED: 'scaling matrix present' }
  }
  out.log2_max_frame_num_minus4 = r.ue()
  const pocType = r.ue()
  out.pic_order_cnt_type = pocType
  if (pocType === 0) out.log2_max_pic_order_cnt_lsb_minus4 = r.ue()
  else if (pocType === 1) return { ...out, PARSE_STOPPED: 'poc type 1' }
  out.max_num_ref_frames = r.ue()
  out.gaps_in_frame_num_value_allowed_flag = r.flag()
  out.pic_width_in_mbs_minus1 = r.ue()
  out.pic_height_in_map_units_minus1 = r.ue()
  out.frame_mbs_only_flag = r.flag()
  return out
}

function parsePps(nal: Uint8Array): Record<string, number | boolean> {
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const out: Record<string, number | boolean> = {}
  out.pic_parameter_set_id = r.ue()
  out.seq_parameter_set_id = r.ue()
  out.entropy_coding_mode_flag = r.flag()
  out.bottom_field_pic_order_in_frame_present_flag = r.flag()
  out.num_slice_groups_minus1 = r.ue()
  out.num_ref_idx_l0_default_active_minus1 = r.ue()
  out.num_ref_idx_l1_default_active_minus1 = r.ue()
  out.weighted_pred_flag = r.flag()
  out.weighted_bipred_idc = r.u(2)
  out.pic_init_qp_minus26 = r.se()
  out.pic_init_qs_minus26 = r.se()
  out.chroma_qp_index_offset = r.se()
  out.deblocking_filter_control_present_flag = r.flag()
  out.constrained_intra_pred_flag = r.flag()
  out.redundant_pic_cnt_present_flag = r.flag()
  return out
}

/** avcC (AVCDecoderConfigurationRecord) → the SPS and PPS NALs inside it. */
function splitAvcC(desc: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } {
  const sps: Uint8Array[] = []
  const pps: Uint8Array[] = []
  let p = 5
  const numSps = desc[p++] & 0x1f
  for (let i = 0; i < numSps; i++) {
    const len = (desc[p] << 8) | desc[p + 1]
    p += 2
    sps.push(desc.subarray(p, p + len))
    p += len
  }
  const numPps = desc[p++]
  for (let i = 0; i < numPps; i++) {
    const len = (desc[p] << 8) | desc[p + 1]
    p += 2
    pps.push(desc.subarray(p, p + len))
    p += len
  }
  return { sps, pps }
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
  const spsParsed = sps.length ? parseSps(sps[0]) : {}
  const ppsParsed = pps.length ? parsePps(pps[0]) : {}

  const cabac = ppsParsed.entropy_coding_mode_flag === true
  verdict.push(cabac ? 'CABAC — an all-skip slice needs an arithmetic coder' : 'CAVLC — an all-skip slice is one ue(v)')
  verdict.push(`pic_order_cnt_type ${spsParsed.pic_order_cnt_type}`)
  const nonRef = packets.filter((p) => p.nalRefIdc === 0).length
  verdict.push(`${nonRef} of ${packets.length} packets are non-reference`)

  // ---- read VT's own numbering back ---------------------------------------
  const headers = bodies.map((b) => parsePSliceHeader(b.subarray(4), spsParsed, ppsParsed))
  const readable = headers.filter((h): h is SliceHeader => h !== null).length
  verdict.push(`slice headers parsed: ${readable}/${headers.length}`)
  const pocs = headers.map((h) => h?.pic_order_cnt_lsb ?? -1)
  const fnums = headers.map((h) => h?.frame_num ?? -1)
  verdict.push(`poc_lsb[0..6] ${pocs.slice(0, 7).join(',')} · frame_num[0..6] ${fnums.slice(0, 7).join(',')}`)

  const hAt = headers[at]
  const hNext = headers[at + 1]
  if (!hAt || !hNext) {
    verdict.push('CANNOT SPLICE — slice headers at the injection point did not parse')
    return { codec, width, height, frames, sps: spsParsed, pps: ppsParsed, packets: packets.slice(0, 8), verdict }
  }

  const pocGap = hNext.pic_order_cnt_lsb - hAt.pic_order_cnt_lsb
  verdict.push(`poc gap across the injection point: ${pocGap}`)
  if (pocGap < 2) {
    verdict.push('NO ROOM FOR A POC — the encoder numbers consecutive pictures 1 apart, so an inserted picture has no legal order value between them')
  }
  const injectedPoc = hAt.pic_order_cnt_lsb + Math.floor(pocGap / 2)

  // frame_num of a non-reference picture is the NEXT value, which is exactly
  // what the encoder's own following packet already carries.
  const skipNal = buildSkipSlice(spsParsed, ppsParsed, { ...hNext, slice_qp_delta: hAt.slice_qp_delta }, injectedPoc)
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
  }
}

/** RBSP bit writer — the mirror of BitReader, plus emulation prevention. */
class BitWriter {
  private bits: number[] = []
  u(n: number, v: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1)
  }
  ue(v: number): void {
    const code = v + 1
    const len = 32 - Math.clz32(code)
    this.u(len - 1, 0)
    this.u(len, code)
  }
  se(v: number): void {
    this.ue(v <= 0 ? -2 * v : 2 * v - 1)
  }
  flag(b: boolean): void {
    this.bits.push(b ? 1 : 0)
  }
  /** rbsp_trailing_bits(): a 1, then zeros to the byte boundary. */
  finishRbsp(): Uint8Array {
    this.bits.push(1)
    while (this.bits.length % 8 !== 0) this.bits.push(0)
    const out = new Uint8Array(this.bits.length / 8)
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (7 - (i & 7))
    }
    return out
  }
  /** 00 00 00/01/02/03 must become 00 00 03 xx inside a NAL payload. */
  static escape(rbsp: Uint8Array): Uint8Array {
    const out: number[] = []
    let zeros = 0
    for (const b of rbsp) {
      if (zeros >= 2 && b <= 3) {
        out.push(0x03)
        zeros = 0
      }
      out.push(b)
      zeros = b === 0 ? zeros + 1 : 0
    }
    return new Uint8Array(out)
  }
}

export interface SliceHeader {
  first_mb_in_slice: number
  slice_type: number
  pic_parameter_set_id: number
  frame_num: number
  pic_order_cnt_lsb: number
  slice_qp_delta: number
  disable_deblocking_filter_idc: number
}

/** Enough of a P-slice header to read VT's own numbering back. */
function parsePSliceHeader(
  nal: Uint8Array,
  sps: Record<string, number | boolean | string>,
  pps: Record<string, number | boolean>,
): SliceHeader | null {
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const h = {} as SliceHeader
  h.first_mb_in_slice = r.ue()
  h.slice_type = r.ue()
  h.pic_parameter_set_id = r.ue()
  h.frame_num = r.u((sps.log2_max_frame_num_minus4 as number) + 4)
  // frame_mbs_only_flag is 1 here, so no field_pic_flag.
  const isIdr = (nal[0] & 0x1f) === 5
  if (isIdr) r.ue() // idr_pic_id
  if (sps.pic_order_cnt_type === 0) {
    h.pic_order_cnt_lsb = r.u((sps.log2_max_pic_order_cnt_lsb_minus4 as number) + 4)
  } else return null
  if (pps.redundant_pic_cnt_present_flag) r.ue()
  const sliceType = h.slice_type % 5
  if (sliceType === 0) {
    // P: num_ref_idx_active_override_flag, then ref_pic_list_modification
    if (r.flag()) r.ue()
    if (r.flag()) {
      // modification list — walk it until the terminator
      for (;;) {
        const op = r.ue()
        if (op === 3) break
        r.ue()
      }
    }
  }
  if (isIdr) {
    r.flag() // no_output_of_prior_pics_flag
    r.flag() // long_term_reference_flag
  } else if ((nal[0] >> 5) & 3) {
    if (r.flag()) {
      for (;;) {
        const op = r.ue()
        if (op === 0) break
        if (op === 1 || op === 3) r.ue()
        if (op === 2) r.ue()
        if (op === 4) r.ue()
        if (op === 6) r.ue()
        if (op === 5) break
      }
    }
  }
  h.slice_qp_delta = r.se()
  h.disable_deblocking_filter_idc = 0
  if (pps.deblocking_filter_control_present_flag) {
    h.disable_deblocking_filter_idc = r.ue()
  }
  return h
}

/**
 * ONE PICTURE THAT MEANS "IDENTICAL TO THE ONE BEFORE IT".
 *
 * A non-reference P slice in which every macroblock is skipped. In CAVLC that
 * is the whole slice data: `mb_skip_run = PicSizeInMbs`. The first macroblock
 * has no left or top neighbour so its skip motion vector is inferred as zero,
 * and every macroblock after it inherits zero by the same rule — so the picture
 * is a zero-motion copy of the reference with no residual anywhere. Boundary
 * strength is 0 across all of it (no coefficients, one reference, no motion
 * difference), so the deblocking filter does not run either.
 *
 * nal_ref_idc = 0 is what makes it safe to inject: a non-reference picture does
 * not advance frame_num and never enters the DPB, so every packet the encoder
 * emits after it keeps the numbering it was written with.
 */
export function buildSkipSlice(
  sps: Record<string, number | boolean | string>,
  pps: Record<string, number | boolean>,
  after: SliceHeader,
  picOrderCntLsb: number,
): Uint8Array {
  const w = new BitWriter()
  w.ue(0) // first_mb_in_slice
  w.ue(5) // slice_type: P, and all slices in the picture are P
  w.ue(pps.pic_parameter_set_id as number)
  w.u((sps.log2_max_frame_num_minus4 as number) + 4, after.frame_num)
  w.u((sps.log2_max_pic_order_cnt_lsb_minus4 as number) + 4, picOrderCntLsb)
  // redundant_pic_cnt_present_flag is false here, so nothing to write.
  w.flag(false) // num_ref_idx_active_override_flag — take the PPS default
  w.flag(false) // ref_pic_list_modification_flag_l0 — reference 0 is the previous picture
  // weighted_pred_flag is false; nal_ref_idc is 0 so there is no dec_ref_pic_marking.
  w.se(after.slice_qp_delta)
  if (pps.deblocking_filter_control_present_flag) {
    w.ue(after.disable_deblocking_filter_idc)
    if (after.disable_deblocking_filter_idc !== 1) {
      w.se(0) // slice_alpha_c0_offset_div2
      w.se(0) // slice_beta_offset_div2
    }
  }
  const widthMbs = (sps.pic_width_in_mbs_minus1 as number) + 1
  const heightMbs = (sps.pic_height_in_map_units_minus1 as number) + 1
  w.ue(widthMbs * heightMbs) // mb_skip_run — every macroblock, and that is the slice
  const rbsp = w.finishRbsp()
  const escaped = BitWriter.escape(rbsp)
  const nal = new Uint8Array(1 + escaped.length)
  nal[0] = 0x01 // nal_ref_idc = 0, nal_unit_type = 1 (non-IDR slice)
  nal.set(escaped, 1)
  return nal
}
