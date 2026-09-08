import { EncodedPacket } from 'mediabunny'
import { describe, expect, it } from 'vitest'
import { avccNals, parsePps, parseSliceHeader, parseSps, splitAvcC } from './avcSkipPicture'
import { FIXTURE_AVCC, FIXTURE_PACKETS } from './avcStreamFixture'
import { SameAsLastPlan, samePictureKey } from './sameAsLast'

const FPS = 60
const { sps: spsNals, pps: ppsNals } = splitAvcC(FIXTURE_AVCC)
const sps = parseSps(spsNals[0])
const pps = parsePps(ppsNals[0])

const at = (slot: number): number => slot / FPS
const META = { decoderConfig: { description: FIXTURE_AVCC } }

function packet(i: number, slot: number): EncodedPacket {
  const f = FIXTURE_PACKETS[i]
  return new EncodedPacket(f.data, f.type, at(slot), 1 / FPS)
}

function headerOf(p: EncodedPacket) {
  const [{ start, end }] = avccNals(p.data)
  return parseSliceHeader(p.data.subarray(start, end), sps, pps)!
}

/** Drives a plan and collects what leaves it, in order. */
function collector() {
  const out: EncodedPacket[] = []
  return { out, emit: (p: EncodedPacket) => void out.push(p) }
}

describe('what counts as the same picture', () => {
  it('is the same sources and nothing else moving', () => {
    const a = samePictureKey({ samples: [{ channelId: 'screen', timestamp: 1.5 }], pose: { x: 0 } })
    const b = samePictureKey({ samples: [{ channelId: 'screen', timestamp: 1.5 }], pose: { x: 0 } })
    expect(a).toBe(b)
  })

  it('is not the same when the source sample moves, even by one frame', () => {
    const a = samePictureKey({ samples: [{ channelId: 'screen', timestamp: 1.5 }] })
    const b = samePictureKey({ samples: [{ channelId: 'screen', timestamp: 1.516 }] })
    expect(a).not.toBe(b)
  })

  it('is not the same when the camera pose or the viewport moves under a still source', () => {
    const still = [{ channelId: 'screen', timestamp: 1.5 }]
    expect(samePictureKey({ samples: still, pose: { x: 0 } })).not.toBe(
      samePictureKey({ samples: still, pose: { x: 1 } }),
    )
    expect(samePictureKey({ samples: still, view: { zoom: 1 } })).not.toBe(
      samePictureKey({ samples: still, view: { zoom: 2 } })
    )
  })

  it('is not the same when a channel drops out of the slot', () => {
    expect(samePictureKey({ samples: [{ channelId: 'cam', timestamp: 2 }] })).not.toBe(
      samePictureKey({ samples: [{ channelId: 'cam', timestamp: null }] }),
    )
  })
})

describe('the ordering machine', () => {
  it('puts written pictures between the real ones, at their own slots', () => {
    const plan = new SameAsLastPlan(FPS)
    const { out, emit } = collector()

    expect(plan.offer(at(0), 1 / FPS, true)).toBe('encode')
    expect(plan.offer(at(1), 1 / FPS, false)).toBe('encode')
    plan.onPacket(packet(0, 0), META, emit)
    plan.onPacket(packet(1, 1), undefined, emit)

    // Armed only now: the encoder's own spacing has been read off a real packet.
    plan.markDuplicate(at(2))
    plan.markDuplicate(at(3))
    expect(plan.offer(at(2), 1 / FPS, false)).toBe('skip')
    expect(plan.offer(at(3), 1 / FPS, false)).toBe('skip')
    expect(plan.offer(at(4), 1 / FPS, false)).toBe('encode')
    plan.onPacket(packet(2, 4), undefined, emit)
    plan.flush(emit)

    expect(out.map((p) => Math.round(p.timestamp * FPS))).toEqual([0, 1, 2, 3, 4])
    expect(out.map((p) => p.type)).toEqual(['key', 'delta', 'delta', 'delta', 'delta'])
    // ONE PICTURE PER SLOT, numbered in slot order — the gap the injected
    // pictures needed was made by moving the real one up, not by luck.
    expect(out.map((p) => headerOf(p).pic_order_cnt_lsb)).toEqual([0, 1, 2, 3, 4])
    // 13 bytes each: four of length prefix and nine of picture. Nine and not
    // the task's fourteen because this fixture is 640x384 — 960 macroblocks,
    // so `mb_skip_run` is a shorter ue(v) than the 14400 of a 1440p take.
    expect(plan.stats).toEqual({ slots: 5, marked: 2, duplicates: 2, written: 2, bytes: 26, refusal: null })
  })

  it('writes pictures that are non-reference and carry the next reference frame_num', () => {
    const plan = new SameAsLastPlan(FPS)
    const { out, emit } = collector()
    plan.offer(at(0), 1 / FPS, true)
    plan.offer(at(1), 1 / FPS, false)
    plan.onPacket(packet(0, 0), META, emit)
    plan.onPacket(packet(1, 1), undefined, emit)
    plan.markDuplicate(at(2))
    plan.markDuplicate(at(3))
    plan.offer(at(2), 1 / FPS, false)
    plan.offer(at(3), 1 / FPS, false)
    plan.flush(emit)

    const written = out.slice(2)
    expect(written).toHaveLength(2)
    for (const p of written) {
      expect(p.data.length).toBe(13) // four bytes of length, nine of picture
      const [{ start }] = avccNals(p.data)
      expect((p.data[start] >> 5) & 3).toBe(0) // nal_ref_idc: never a reference
      // The previous reference picture had frame_num 1, so every non-reference
      // picture after it carries 2 — including a run of them.
      expect(headerOf(p).frame_num).toBe(2)
    }
  })

  it('never writes one where a key frame belongs', () => {
    const plan = new SameAsLastPlan(FPS)
    const { emit } = collector()
    plan.offer(at(0), 1 / FPS, true)
    plan.offer(at(1), 1 / FPS, false)
    plan.onPacket(packet(0, 0), META, emit)
    plan.onPacket(packet(1, 1), undefined, emit)
    plan.markDuplicate(at(2))
    expect(plan.offer(at(2), 1 / FPS, true)).toBe('encode')
    expect(plan.stats.written).toBe(0)
  })

  it('cannot promise a picture before it has read the stream, so the first frames encode', () => {
    const plan = new SameAsLastPlan(FPS)
    plan.markDuplicate(at(1))
    plan.offer(at(0), 1 / FPS, true)
    expect(plan.offer(at(1), 1 / FPS, false)).toBe('encode')
    expect(plan.stats.duplicates).toBe(1)
    expect(plan.stats.written).toBe(0)
  })

  it('hands back the encoder’s own packets, untouched, when nothing is duplicated', () => {
    const plan = new SameAsLastPlan(FPS)
    const { out, emit } = collector()
    const given = [packet(0, 0), packet(1, 1), packet(2, 2), packet(3, 3)]
    given.forEach((_, i) => plan.offer(at(i), 1 / FPS, i === 0))
    given.forEach((p, i) => plan.onPacket(p, i === 0 ? META : undefined, emit))
    plan.flush(emit)
    expect(out).toEqual(given)
    expect(plan.stats.written).toBe(0)
  })

  it('declines a stream it cannot write into, and says which one, and stays out of it', () => {
    const plan = new SameAsLastPlan(FPS)
    const { out, emit } = collector()
    // A description that is not an avcC at all — the encoder is encoding
    // something this engine has no business in.
    const doctored = { decoderConfig: { description: new Uint8Array([9, 9, 9, 9, 9, 9, 9]) } }
    plan.offer(at(0), 1 / FPS, true)
    plan.onPacket(packet(0, 0), doctored, emit)
    plan.markDuplicate(at(1))
    expect(plan.offer(at(1), 1 / FPS, false)).toBe('encode')
    expect(plan.stats.refusal).toMatch(/avcC/)
    expect(out).toHaveLength(1)
  })
})
