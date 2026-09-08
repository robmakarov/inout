import { describe, expect, it } from 'vitest'
import {
  BitReader,
  BitWriter,
  avccNals,
  avccWrap,
  buildSkipSlice,
  maxPicOrderCntLsb,
  parsePps,
  parseSliceHeader,
  parseSps,
  setPicOrderCntLsb,
  skipPictureRefusal,
  splitAvcC,
} from './avcSkipPicture'
import { FIXTURE_AVCC, FIXTURE_PACKETS } from './avcStreamFixture'

const { sps: spsNals, pps: ppsNals } = splitAvcC(FIXTURE_AVCC)
const sps = parseSps(spsNals[0])
const pps = parsePps(ppsNals[0])

/** The first NAL of a packet, without its 4-byte length prefix. */
function firstNal(data: Uint8Array): Uint8Array {
  const [{ start, end }] = avccNals(data)
  return data.subarray(start, end)
}

describe('the stream this machine actually emits', () => {
  it('is Baseline, CAVLC, pic_order_cnt_type 0 — the three facts the engine rests on', () => {
    expect(sps.profile_idc).toBe(66)
    expect(pps.entropy_coding_mode_flag).toBe(false)
    expect(sps.pic_order_cnt_type).toBe(0)
    expect(sps.frame_mbs_only_flag).toBe(true)
    expect(skipPictureRefusal(sps, pps)).toBeNull()
  })

  it('numbers its pictures one apart, which is why anything has to be renumbered', () => {
    const pocs = FIXTURE_PACKETS.map((p) => parseSliceHeader(firstNal(p.data), sps, pps)?.pic_order_cnt_lsb)
    const nums = FIXTURE_PACKETS.map((p) => parseSliceHeader(firstNal(p.data), sps, pps)?.frame_num)
    expect(pocs).toEqual([0, 1, 2, 3])
    expect(nums).toEqual([0, 1, 2, 3])
  })

  it('reads the quantizer off a P slice and never off the key frame', () => {
    const key = parseSliceHeader(firstNal(FIXTURE_PACKETS[0].data), sps, pps)!
    const p = parseSliceHeader(firstNal(FIXTURE_PACKETS[1].data), sps, pps)!
    expect(key.isIdr).toBe(true)
    expect(key.sliceType).toBe(2) // I
    expect(key.tail).toBeNull()
    expect(p.sliceType).toBe(0) // P
    expect(p.tail).not.toBeNull()
    expect(26 + pps.pic_init_qp_minus26 + p.tail!.slice_qp_delta).toBeGreaterThanOrEqual(0)
  })
})

describe('how this encoder holds its pictures — the defect that cost a run', () => {
  it('marks its own P pictures long-term, which is why a skip slice cannot trust the default list', () => {
    const p = parseSliceHeader(firstNal(FIXTURE_PACKETS[1].data), sps, pps)!
    expect(p.marking).not.toBeNull()
    // If this ever comes back short-term, the encoder changed and the reason
    // for `ref_pic_list_modification` in the skip slice changed with it — the
    // slice stays correct either way, because it NAMES what it copies.
    expect(p.marking!.kind).toBe('long')
  })

  it('names a long-term picture by its own number', () => {
    const ref = { kind: 'long' as const, picNum: 1 }
    const nal = buildSkipSlice(sps, pps, { frame_num: 3, slice_qp_delta: 0, disable_deblocking_filter_idc: 0 }, 7, ref)
    const r = new BitReader(BitReader.unescape(nal.subarray(1)))
    r.ue() // first_mb_in_slice
    r.ue() // slice_type
    r.ue() // pic_parameter_set_id
    r.u(sps.log2_max_frame_num_minus4 + 4)
    r.u(sps.log2_max_pic_order_cnt_lsb_minus4 + 4)
    r.flag() // num_ref_idx_active_override_flag
    expect(r.flag()).toBe(true) // ref_pic_list_modification_flag_l0
    expect(r.ue()).toBe(2) // pick by long-term picture number
    expect(r.ue()).toBe(1) // and that number is the one it was given
    expect(r.ue()).toBe(3)
  })
})

describe('what the engine refuses', () => {
  it('refuses CABAC by name rather than writing a slice it cannot write', () => {
    expect(skipPictureRefusal(sps, { ...pps, entropy_coding_mode_flag: true })).toMatch(/CABAC/)
  })
  it('refuses a stream whose pictures cannot be numbered between', () => {
    expect(skipPictureRefusal({ ...sps, pic_order_cnt_type: 2 }, pps)).toMatch(/pic_order_cnt_type 2/)
  })
  it('refuses fields, slice groups, redundant pictures and weighted prediction', () => {
    expect(skipPictureRefusal({ ...sps, frame_mbs_only_flag: false }, pps)).toMatch(/fields/)
    expect(skipPictureRefusal(sps, { ...pps, num_slice_groups_minus1: 1 })).toMatch(/slice groups/)
    expect(skipPictureRefusal(sps, { ...pps, redundant_pic_cnt_present_flag: true })).toMatch(/redundant/)
    expect(skipPictureRefusal(sps, { ...pps, weighted_pred_flag: true })).toMatch(/weighted/)
  })
})

describe('the bits', () => {
  it('writes back what it reads — u, ue and se, including the negatives', () => {
    const w = new BitWriter()
    w.u(13, 4242)
    w.ue(0)
    w.ue(14399)
    w.se(-7)
    w.se(7)
    w.flag(true)
    const r = new BitReader(w.finishRbsp())
    expect(r.u(13)).toBe(4242)
    expect(r.ue()).toBe(0)
    expect(r.ue()).toBe(14399)
    expect(r.se()).toBe(-7)
    expect(r.se()).toBe(7)
    expect(r.flag()).toBe(true)
  })

  it('escapes and unescapes the sequences that would otherwise read as a start code', () => {
    const raw = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0x9a, 0x00, 0x00, 0x03])
    const escaped = BitWriter.escape(raw)
    expect(escaped.length).toBeGreaterThan(raw.length)
    expect(Array.from(BitReader.unescape(escaped))).toEqual(Array.from(raw))
  })
})

describe('renumbering a picture in place', () => {
  it('moves pic_order_cnt_lsb and leaves every other field where it was', () => {
    const nal = firstNal(FIXTURE_PACKETS[2].data)
    const before = parseSliceHeader(nal, sps, pps)!
    const patched = setPicOrderCntLsb(nal, sps, before, 4242)
    const after = parseSliceHeader(patched, sps, pps)!
    expect(after.pic_order_cnt_lsb).toBe(4242)
    expect(after.frame_num).toBe(before.frame_num)
    expect(after.first_mb_in_slice).toBe(before.first_mb_in_slice)
    expect(after.sliceType).toBe(before.sliceType)
    expect(after.tail).toEqual(before.tail)
    // The payload after the header is untouched: same length, and the only
    // bytes that differ are the ones the order value lives in.
    expect(patched.length).toBe(nal.length)
  })

  it('survives a value at the top of the range', () => {
    const nal = firstNal(FIXTURE_PACKETS[1].data)
    const before = parseSliceHeader(nal, sps, pps)!
    const top = maxPicOrderCntLsb(sps) - 1
    const after = parseSliceHeader(setPicOrderCntLsb(nal, sps, before, top), sps, pps)!
    expect(after.pic_order_cnt_lsb).toBe(top)
    expect(after.tail).toEqual(before.tail)
  })
})

describe('the picture that means "identical to the one before it"', () => {
  const mbs = (sps.pic_width_in_mbs_minus1 + 1) * (sps.pic_height_in_map_units_minus1 + 1)
  const nal = buildSkipSlice(
    sps,
    pps,
    { frame_num: 4, slice_qp_delta: 3, disable_deblocking_filter_idc: 0 },
    9,
    { kind: 'short', picNum: 3 },
  )

  it('is a non-reference P slice, and small', () => {
    expect(nal.length).toBeLessThanOrEqual(18)
    expect((nal[0] >> 5) & 3).toBe(0) // nal_ref_idc — out of the DPB
    expect(nal[0] & 0x1f).toBe(1) // non-IDR slice
    const h = parseSliceHeader(nal, sps, pps)!
    expect(h.sliceType).toBe(0)
    expect(h.frame_num).toBe(4)
    expect(h.pic_order_cnt_lsb).toBe(9)
    expect(h.tail).toEqual({ slice_qp_delta: 3, disable_deblocking_filter_idc: 0 })
  })

  it('skips every macroblock in the picture — one mb_skip_run and nothing else', () => {
    const h = parseSliceHeader(nal, sps, pps)!
    const r = new BitReader(BitReader.unescape(nal.subarray(1)))
    r.ue() // first_mb_in_slice
    r.ue() // slice_type
    r.ue() // pic_parameter_set_id
    r.u(sps.log2_max_frame_num_minus4 + 4)
    r.u(sps.log2_max_pic_order_cnt_lsb_minus4 + 4)
    r.flag() // num_ref_idx_active_override_flag
    expect(r.flag()).toBe(true) // ref_pic_list_modification_flag_l0 — it NAMES its reference
    expect(r.ue()).toBe(0) // modification_of_pic_nums_idc: subtract from CurrPicNum
    expect(r.ue()).toBe(0) // abs_diff_pic_num_minus1: the picture one before it
    expect(r.ue()).toBe(3) // and that is the whole modification
    r.se() // slice_qp_delta
    if (pps.deblocking_filter_control_present_flag) {
      const idc = r.ue()
      if (idc !== 1) {
        r.se()
        r.se()
      }
    }
    expect(r.ue()).toBe(mbs)
    expect(h.first_mb_in_slice).toBe(0)
  })

  it('wraps into a packet the muxer can take', () => {
    const packet = avccWrap(nal)
    expect(packet.length).toBe(nal.length + 4)
    const [{ start, end }] = avccNals(packet)
    expect(Array.from(packet.subarray(start, end))).toEqual(Array.from(nal))
  })
})
