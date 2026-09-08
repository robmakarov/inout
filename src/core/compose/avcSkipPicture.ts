/**
 * ONE H.264 PICTURE THAT MEANS "IDENTICAL TO THE ONE BEFORE IT" — task J13.
 *
 * The bitstream half of "same as last frame", and nothing else: parse what this
 * machine's encoder emitted, build the 14-byte picture, and renumber the
 * pictures that follow it. It knows nothing about the render, the muxer or the
 * take — `sameAsLast.ts` owns all of that. Pure functions over bytes, so every
 * claim below is a unit test rather than a rig.
 *
 * WHY IT IS SAFE TO WRITE ONE. A non-reference P slice in which every
 * macroblock is skipped is a zero-motion copy of the reference with no residual
 * anywhere: the first macroblock has no left or top neighbour so its skip
 * motion vector is inferred as zero, and every macroblock after it inherits
 * zero by the same rule. Boundary strength is 0 across all of it, so the
 * deblocking filter does not run either. `nal_ref_idc = 0` keeps it out of the
 * DPB and out of the frame_num sequence, so every packet the encoder emitted
 * after it keeps the numbering it was written with.
 *
 * WHAT THIS MACHINE ACTUALLY EMITS, measured 2026-09-08 through the export's
 * own `constantQualityCodec` at every size the export uses (`exp skipframe`):
 *
 *   2560x1440  avc1.42E032   1920x1080  avc1.42E028
 *   3024x1964  avc1.42E033   3840x2160  avc1.42E033
 *
 * — Baseline (profile_idc 66) at all four, so `entropy_coding_mode_flag` is
 * false and an all-skip slice is one `ue(v)`. CABAC would need an arithmetic
 * coder and is REFUSED here rather than guessed at; `pic_order_cnt_type` is 0
 * at all four, which is what lets a picture be numbered between two others.
 * (The stale note in constantQuality.ts about Baseline being impossible at
 * 1080p is about some other config: the probe picks it at 1080p every time.)
 *
 * THE ONE THING THAT IS NOT FREE, and it is why `setPicOrderCntLsb` exists:
 * VideoToolbox numbers consecutive pictures 1 apart, so there is no order value
 * between two of them. An injected picture takes the next slot's number and
 * every real picture after it in the same GOP moves up by one. That is a
 * fixed-width `u(v)` in the slice header, so it is patched in place — unescape,
 * write, re-escape — with no re-encode and no shift of any other field.
 */

/** Minimal RBSP bit reader — Annex B emulation-prevention bytes removed. */
export class BitReader {
  private pos = 0
  constructor(private readonly buf: Uint8Array) {}
  /** 00 00 03 xx inside a NAL payload is 00 00 xx in the RBSP. */
  static unescape(nal: Uint8Array): Uint8Array {
    const out = new Uint8Array(nal.length)
    let n = 0
    for (let i = 0; i < nal.length; i++) {
      if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) continue
      out[n++] = nal[i]
    }
    return out.subarray(0, n)
  }
  get bitPos(): number {
    return this.pos
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

export class BitWriter {
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

export interface AvcSps {
  profile_idc: number
  level_idc: number
  seq_parameter_set_id: number
  log2_max_frame_num_minus4: number
  pic_order_cnt_type: number
  log2_max_pic_order_cnt_lsb_minus4: number
  max_num_ref_frames: number
  pic_width_in_mbs_minus1: number
  pic_height_in_map_units_minus1: number
  frame_mbs_only_flag: boolean
  /** Set when the parse stopped early — the SPS is then not usable here. */
  stopped?: string
}

export interface AvcPps {
  pic_parameter_set_id: number
  seq_parameter_set_id: number
  entropy_coding_mode_flag: boolean
  bottom_field_pic_order_in_frame_present_flag: boolean
  num_slice_groups_minus1: number
  num_ref_idx_l0_default_active_minus1: number
  weighted_pred_flag: boolean
  weighted_bipred_idc: number
  pic_init_qp_minus26: number
  deblocking_filter_control_present_flag: boolean
  redundant_pic_cnt_present_flag: boolean
}

/**
 * HOW A DECODED PICTURE IS HELD, and therefore how another picture NAMES it.
 *
 * A reference is short-term (named by its PicNum, which is its frame_num here)
 * or long-term (named by its LongTermPicNum, which is the `long_term_frame_idx`
 * it marked itself with). This product's encoder uses BOTH — measured, not
 * assumed: every P picture it emits carries `memory_management_control_operation
 * 6`, marking ITSELF long-term.
 */
export type AvcReference = { kind: 'short'; picNum: number } | { kind: 'long'; picNum: number }

export interface AvcSliceHeader {
  first_mb_in_slice: number
  /** slice_type % 5: 0 = P, 1 = B, 2 = I. */
  sliceType: number
  nalRefIdc: number
  isIdr: boolean
  pic_parameter_set_id: number
  frame_num: number
  pic_order_cnt_lsb: number
  /** Bit offset of `pic_order_cnt_lsb` inside the UNESCAPED payload RBSP. */
  pocBitOffset: number
  /**
   * THE FIELDS AN INJECTED PICTURE HAS TO COPY, and they are separate because
   * reading them is a different risk from reading the ones above. Everything
   * before `pic_order_cnt_lsb` is four syntax elements deep and the same for
   * every slice type; `slice_qp_delta` sits behind the reference-list and
   * reference-marking structures, which differ per slice type and can carry
   * loops. So the prefix is parsed for EVERY picture (renumbering needs it and
   * must never be wrong), and this tail only for the P slices an injected
   * picture is copied from. Null means "not read", never "zero".
   */
  tail: { slice_qp_delta: number; disable_deblocking_filter_idc: number } | null
  /**
   * How THIS picture will be held once it is decoded — what a later picture
   * has to say to point at it. Read out of `dec_ref_pic_marking`, so it is the
   * encoder's own decision and never a guess. Null for a non-reference picture
   * (nothing can point at one) and when the marking did not parse.
   */
  marking: AvcReference | null
}

/** Profiles whose SPS carries the chroma_format_idc block. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

export function parseSps(nal: Uint8Array): AvcSps {
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const out = {} as AvcSps
  const profile_idc = r.u(8)
  out.profile_idc = profile_idc
  r.u(8) // constraint flags
  out.level_idc = r.u(8)
  out.seq_parameter_set_id = r.ue()
  if (HIGH_PROFILES.has(profile_idc)) {
    const chroma = r.ue()
    if (chroma === 3) r.flag() // separate_colour_plane_flag
    r.ue() // bit_depth_luma_minus8
    r.ue() // bit_depth_chroma_minus8
    r.flag() // qpprime_y_zero_transform_bypass_flag
    if (r.flag()) {
      out.stopped = 'scaling matrix present'
      return out
    }
  }
  out.log2_max_frame_num_minus4 = r.ue()
  const pocType = r.ue()
  out.pic_order_cnt_type = pocType
  if (pocType === 0) out.log2_max_pic_order_cnt_lsb_minus4 = r.ue()
  else if (pocType === 1) {
    out.stopped = 'poc type 1'
    return out
  }
  out.max_num_ref_frames = r.ue()
  r.flag() // gaps_in_frame_num_value_allowed_flag
  out.pic_width_in_mbs_minus1 = r.ue()
  out.pic_height_in_map_units_minus1 = r.ue()
  out.frame_mbs_only_flag = r.flag()
  return out
}

export function parsePps(nal: Uint8Array): AvcPps {
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const out = {} as AvcPps
  out.pic_parameter_set_id = r.ue()
  out.seq_parameter_set_id = r.ue()
  out.entropy_coding_mode_flag = r.flag()
  out.bottom_field_pic_order_in_frame_present_flag = r.flag()
  out.num_slice_groups_minus1 = r.ue()
  out.num_ref_idx_l0_default_active_minus1 = r.ue()
  r.ue() // num_ref_idx_l1_default_active_minus1
  out.weighted_pred_flag = r.flag()
  out.weighted_bipred_idc = r.u(2)
  out.pic_init_qp_minus26 = r.se()
  r.se() // pic_init_qs_minus26
  r.se() // chroma_qp_index_offset
  out.deblocking_filter_control_present_flag = r.flag()
  r.flag() // constrained_intra_pred_flag
  out.redundant_pic_cnt_present_flag = r.flag()
  return out
}

/** avcC (AVCDecoderConfigurationRecord) → the SPS and PPS NALs inside it. */
export function splitAvcC(desc: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } {
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

export function maxFrameNum(sps: AvcSps): number {
  return 1 << (sps.log2_max_frame_num_minus4 + 4)
}

export function maxPicOrderCntLsb(sps: AvcSps): number {
  return 1 << (sps.log2_max_pic_order_cnt_lsb_minus4 + 4)
}

/**
 * WHY THIS STREAM CANNOT CARRY AN INJECTED PICTURE — or null when it can.
 *
 * Every clause is a thing this module would otherwise have to guess at, and the
 * whole engine declines on any one of them rather than writing a stream only
 * one decoder tolerates. The refusal is a SENTENCE because it is printed: an
 * agent reading "same as last frame: declined — CABAC" knows the whole story.
 */
export function skipPictureRefusal(sps: AvcSps, pps: AvcPps): string | null {
  if (sps.stopped) return `the sequence header stopped parsing at ${sps.stopped}`
  if (pps.entropy_coding_mode_flag)
    return 'CABAC — an all-skip slice needs an arithmetic coder, and this only writes CAVLC'
  if (sps.pic_order_cnt_type !== 0)
    return `pic_order_cnt_type ${sps.pic_order_cnt_type} — a picture cannot be numbered between two others`
  if (!sps.frame_mbs_only_flag) return 'fields — this only writes frame pictures'
  if (pps.num_slice_groups_minus1 !== 0) return 'slice groups — the macroblock order is not raster'
  if (pps.bottom_field_pic_order_in_frame_present_flag)
    return 'delta_pic_order_cnt_bottom is present in the slice header'
  if (pps.redundant_pic_cnt_present_flag) return 'redundant pictures are present'
  if (pps.weighted_pred_flag) return 'weighted prediction — a skipped macroblock would not be a plain copy'
  return null
}

/**
 * Parse a slice header far enough to renumber it and to copy what an injected
 * picture must match. Returns null for anything this module does not write
 * (B slices, and the cases `skipPictureRefusal` names).
 *
 * `nal` is one NAL unit, header byte included.
 */
export function parseSliceHeader(nal: Uint8Array, sps: AvcSps, pps: AvcPps): AvcSliceHeader | null {
  const nalType = nal[0] & 0x1f
  if (nalType !== 1 && nalType !== 5) return null
  const nalRefIdc = (nal[0] >> 5) & 3
  const isIdr = nalType === 5
  const r = new BitReader(BitReader.unescape(nal.subarray(1)))
  const h = { nalRefIdc, isIdr, tail: null, marking: null } as AvcSliceHeader
  h.first_mb_in_slice = r.ue()
  const sliceTypeRaw = r.ue()
  h.sliceType = sliceTypeRaw % 5
  if (h.sliceType !== 0 && h.sliceType !== 2) return null // P and I only; no B
  h.pic_parameter_set_id = r.ue()
  h.frame_num = r.u(sps.log2_max_frame_num_minus4 + 4)
  // frame_mbs_only_flag is checked by skipPictureRefusal, so no field_pic_flag.
  if (isIdr) r.ue() // idr_pic_id
  if (sps.pic_order_cnt_type !== 0) return null
  h.pocBitOffset = r.bitPos
  h.pic_order_cnt_lsb = r.u(sps.log2_max_pic_order_cnt_lsb_minus4 + 4)
  // ── the prefix ends here, and everything above is what renumbering uses ──
  if (pps.redundant_pic_cnt_present_flag) return h
  if (h.sliceType !== 0) {
    // An I slice is never COPIED FROM, but a picture may still be copied from
    // it — the first duplicate slot after a key frame points straight at it —
    // so its marking is read even though its quantizer is not.
    if (isIdr && nalRefIdc !== 0) {
      r.flag() // no_output_of_prior_pics_flag
      h.marking = r.flag() ? { kind: 'long', picNum: 0 } : { kind: 'short', picNum: h.frame_num }
    }
    return h
  }
  if (r.flag()) r.ue() // num_ref_idx_active_override_flag
  if (r.flag()) {
    // ref_pic_list_modification, l0 — walk it to its terminator
    for (let guard = 0; guard < 64; guard++) {
      const op = r.ue()
      if (op === 3) break
      r.ue()
    }
  }
  // weighted_pred_flag is refused by skipPictureRefusal, so no pred_weight_table.
  if (nalRefIdc !== 0) {
    // dec_ref_pic_marking — where the picture says how it will be held.
    h.marking = { kind: 'short', picNum: h.frame_num }
    if (r.flag()) {
      // adaptive_ref_pic_marking_mode_flag — the memory-management ops
      for (let guard = 0; guard < 64; guard++) {
        const op = r.ue()
        if (op === 0) break
        if (op === 1 || op === 3) r.ue() // difference_of_pic_nums_minus1
        if (op === 2) r.ue() // long_term_pic_num
        if (op === 3) r.ue() // long_term_frame_idx (for the picture named above)
        if (op === 4) r.ue() // max_long_term_frame_idx_plus1
        if (op === 6) {
          // THE CURRENT PICTURE MARKS ITSELF LONG-TERM. This is the one that
          // matters here: a long-term picture is not named by its frame_num
          // and does not sort with the short-term ones.
          h.marking = { kind: 'long', picNum: r.ue() }
        }
      }
    }
  }
  // entropy_coding_mode_flag is refused above, so no cabac_init_idc.
  const slice_qp_delta = r.se()
  let disable_deblocking_filter_idc = 0
  if (pps.deblocking_filter_control_present_flag) disable_deblocking_filter_idc = r.ue()
  // A header that parsed into nonsense is not a header. SliceQPY must be a QP.
  const qp = 26 + pps.pic_init_qp_minus26 + slice_qp_delta
  if (qp < 0 || qp > 51) return h
  if (disable_deblocking_filter_idc > 2) return h
  h.tail = { slice_qp_delta, disable_deblocking_filter_idc }
  return h
}

/**
 * The picture itself.
 *
 * IT NAMES THE PICTURE IT COPIES, and that is not belt-and-braces — it is the
 * defect this cost a run to find. The default reference list puts short-term
 * pictures first (descending PicNum) and long-term ones after them (ascending
 * LongTermPicNum), and THIS PRODUCT'S ENCODER MARKS EVERY P PICTURE LONG-TERM
 * (`memory_management_control_operation 6`, measured in its own bitstream). So
 * after a key frame the default index 0 is the KEY FRAME, not the picture
 * immediately before — and a skip slice that trusts the default copies a
 * picture from further back. Measured 2026-09-08: three duplicate slots after
 * every key frame decoded as the key frame's picture, in ffmpeg and in Chrome
 * alike, until this modification was written.
 *
 * So the slice carries a `ref_pic_list_modification` that puts the intended
 * picture at index 0 by name, whichever way it is held.
 */
export function buildSkipSlice(
  sps: AvcSps,
  pps: AvcPps,
  after: { frame_num: number; slice_qp_delta: number; disable_deblocking_filter_idc: number },
  picOrderCntLsb: number,
  /** The picture this one is a copy of, as that picture said it would be held. */
  reference: AvcReference,
): Uint8Array {
  const w = new BitWriter()
  w.ue(0) // first_mb_in_slice
  w.ue(5) // slice_type: P, and all slices in the picture are P
  w.ue(pps.pic_parameter_set_id)
  w.u(sps.log2_max_frame_num_minus4 + 4, after.frame_num)
  w.u(sps.log2_max_pic_order_cnt_lsb_minus4 + 4, picOrderCntLsb)
  w.flag(false) // num_ref_idx_active_override_flag — take the PPS default
  // ref_pic_list_modification_flag_l0: the picture is NAMED, never inferred.
  w.flag(true)
  if (reference.kind === 'long') {
    w.ue(2) // modification_of_pic_nums_idc: pick by long-term picture number
    w.ue(reference.picNum) // long_term_pic_num
  } else {
    w.ue(0) // modification_of_pic_nums_idc: subtract from the current PicNum
    // abs_diff_pic_num_minus1 — this picture's own number, minus the target's.
    const diff = after.frame_num - reference.picNum
    w.ue(Math.max(0, diff - 1))
  }
  w.ue(3) // modification_of_pic_nums_idc: that is the whole modification
  // weighted_pred_flag is refused; nal_ref_idc is 0 so there is no dec_ref_pic_marking.
  w.se(after.slice_qp_delta)
  if (pps.deblocking_filter_control_present_flag) {
    w.ue(after.disable_deblocking_filter_idc)
    if (after.disable_deblocking_filter_idc !== 1) {
      w.se(0) // slice_alpha_c0_offset_div2
      w.se(0) // slice_beta_offset_div2
    }
  }
  const widthMbs = sps.pic_width_in_mbs_minus1 + 1
  const heightMbs = sps.pic_height_in_map_units_minus1 + 1
  w.ue(widthMbs * heightMbs) // mb_skip_run — every macroblock, and that is the slice
  const rbsp = w.finishRbsp()
  const escaped = BitWriter.escape(rbsp)
  const nal = new Uint8Array(1 + escaped.length)
  nal[0] = 0x01 // nal_ref_idc = 0, nal_unit_type = 1 (non-IDR slice)
  nal.set(escaped, 1)
  return nal
}

/**
 * Rewrite one slice header's `pic_order_cnt_lsb`. Fixed-width `u(v)`, so
 * nothing after it moves; the payload is unescaped, the bits are written, and
 * the whole payload is re-escaped, because a changed byte can create or destroy
 * an emulation-prevention sequence.
 */
export function setPicOrderCntLsb(
  nal: Uint8Array,
  sps: AvcSps,
  header: Pick<AvcSliceHeader, 'pocBitOffset'>,
  poc: number,
): Uint8Array {
  const rbsp = BitReader.unescape(nal.subarray(1))
  const bits = sps.log2_max_pic_order_cnt_lsb_minus4 + 4
  let pos = header.pocBitOffset
  for (let i = bits - 1; i >= 0; i--) {
    const bit = (poc >> i) & 1
    const byte = pos >> 3
    const mask = 1 << (7 - (pos & 7))
    rbsp[byte] = bit ? rbsp[byte] | mask : rbsp[byte] & ~mask
    pos++
  }
  const escaped = BitWriter.escape(rbsp)
  const out = new Uint8Array(1 + escaped.length)
  out[0] = nal[0]
  out.set(escaped, 1)
  return out
}

/* ─────────────────── AVCC packets: length-prefixed NALs ─────────────────── */

/** Walk the NAL units of one length-prefixed (`avcC`) packet. */
export function avccNals(data: Uint8Array, lengthSize = 4): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let p = 0
  while (p + lengthSize <= data.length) {
    let len = 0
    for (let i = 0; i < lengthSize; i++) len = (len << 8) | view.getUint8(p + i)
    p += lengthSize
    if (len <= 0 || p + len > data.length) break
    out.push({ start: p, end: p + len })
    p += len
  }
  return out
}

/** One NAL, wrapped as a 4-byte-length-prefixed packet payload — WebCodecs'
 *  `avc` format, which is what every packet in this path carries. */
export function avccWrap(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + nal.length)
  new DataView(out.buffer).setUint32(0, nal.length)
  out.set(nal, 4)
  return out
}
