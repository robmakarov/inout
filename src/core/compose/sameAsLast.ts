/**
 * SAME AS LAST FRAME — task J13. The engine, not the bitstream: `avcSkipPicture.ts`
 * writes the picture, this decides WHEN one may be written and puts it in the
 * stream in the right place with the right number.
 *
 * WHY. R1b measured Robert's 90.4-minute take rendering in 27.2 minutes, and
 * the price is the FRAME COUNT — 325,410 frames at ~2.5-3.6 ms of encoder each.
 * 43.1 % of those frames are exact duplicates THE RENDER INVENTED: capture is
 * frame-driven and omits the ticks where nothing changed (his intervals are
 * exactly 1, 2, 3, 4 x 16.67 ms), while the export writes a constant-rate file
 * at the take's declared 60, so the render refills every omitted tick by
 * drawing and encoding the same picture again.
 *
 * WHAT SHIPS. When an output slot's picture is identical to the slot before it,
 * the file gets the format's own "identical to the previous picture" — a
 * non-reference all-skip P slice, 14 bytes, no encoder call and no composite
 * draw. The file stays CONSTANT-RATE: same duration, same timestamps, same
 * pixels, one picture per slot. It is not the VFR export Robert refused
 * (X10 = O5e, "fuck this").
 *
 * HOW A DUPLICATE IS KNOWN, and this is the task's own gate (DECISIONS robert
 * (8)): from CAPTURE'S OWN RECORD, never from comparing pixels. A slot is a
 * duplicate when every contributing channel hands back the SAME SOURCE SAMPLE
 * as the slot before it — `VideoChannelReader` is a cursor that holds one
 * decoded sample until output time passes the next one, so "the same sample"
 * is the sample's own timestamp, free, with nothing decoded and nothing
 * compared — AND nothing else that draws has moved: no camera pose, no
 * viewport, no background. `samePictureKey` is that rule, in one place.
 *
 * WHERE IT SITS. Inside the constant-quality encoder, which this product
 * already owns (constantQuality.ts, the `registerEncoder` seam). That is also
 * the limit of what it can serve: an export not in quantizer mode has no custom
 * encoder to hold this, and declines to today's render with no penalty.
 *
 * THE ORDERING PROBLEM, because it is the only subtle part. The encoder answers
 * up to four frames late, so a picture injected at the moment the render offers
 * a duplicate would land BEFORE real packets that belong ahead of it. So every
 * offered slot is queued in slot order, a real packet is bound to the earliest
 * unfilled real slot when it arrives, and the queue drains from the head — a
 * skip needs nothing to arrive, a real slot waits for its packet. Packets leave
 * this module in exactly the order the file wants them.
 */
import { EncodedPacket } from 'mediabunny'
import {
  avccNals,
  avccWrap,
  buildSkipSlice,
  maxFrameNum,
  maxPicOrderCntLsb,
  parsePps,
  parseSliceHeader,
  parseSps,
  setPicOrderCntLsb,
  skipPictureRefusal,
  splitAvcC,
  type AvcPps,
  type AvcSliceHeader,
  type AvcSps,
} from './avcSkipPicture'

/**
 * What drew this slot, as one string. Two slots with the same key are the same
 * picture — that is the whole claim, and it is made of the sources' own
 * identities rather than of anything about the pixels.
 */
export function samePictureKey(parts: {
  samples: readonly { readonly channelId: string; readonly timestamp: number | null }[]
  pose?: unknown
  view?: unknown
  background?: unknown
}): string {
  let key = ''
  for (const s of parts.samples) key += `${s.channelId}@${s.timestamp === null ? '-' : s.timestamp};`
  key += `p=${parts.pose === undefined ? '-' : JSON.stringify(parts.pose)};`
  key += `v=${parts.view === undefined ? '-' : JSON.stringify(parts.view)};`
  key += `b=${parts.background === undefined ? '-' : JSON.stringify(parts.background)}`
  return key
}

export interface SameAsLastStats {
  /** Output slots this render offered. */
  slots: number
  /**
   * Slots the RENDER marked as identical to the one before them. Counted where
   * the mark is made rather than where it is read, because the two answer
   * different questions: `marked` says what the provenance rule found, and
   * `duplicates` says how many of those the encoder was actually offered. They
   * differ only if the two disagree about which slot a timestamp is, which is
   * a defect and not a tuning matter.
   */
  marked: number
  /** Slots the render said were identical to the one before them. */
  duplicates: number
  /** Pictures actually written instead of encoded. */
  written: number
  /** What those pictures cost, in bytes. */
  bytes: number
  /** Why nothing was written, when nothing was. */
  refusal: string | null
}

type Entry = {
  readonly slot: number
  readonly timestamp: number
  readonly duration: number
  kind: 'real' | 'skip'
  packet: EncodedPacket | null
  meta: unknown
}

/**
 * One render's worth of state. Created by the render, handed to the encoder on
 * its config (the same trick `markConstantQuality` uses, so it travels with the
 * object and no other export in the tab can pick it up).
 */
export class SameAsLastPlan {
  private readonly entries: Entry[] = []
  private duplicateSlots = new Set<number>()
  private sps: AvcSps | null = null
  private pps: AvcPps | null = null
  /** The encoder's own spacing between consecutive pictures, learned once. */
  private pocStep: number | null = null
  /** Real packets seen since the last key packet — the encoder's own index. */
  private realsSinceIdr = 0
  /** Output slot of the last key packet: every POC in a GOP is relative to it. */
  private idrSlot = 0
  private lastRealFrameNum = 0
  /**
   * The last P slice's quantizer and deblocking settings. A P slice and not
   * just "the last slice", because a key frame is an I slice and carries
   * neither in a form an injected picture may copy — and a duplicate right
   * after a key frame is exactly the case that would otherwise hand this a
   * header with nothing in it.
   */
  private lastPTail: { slice_qp_delta: number; disable_deblocking_filter_idc: number } | null = null
  readonly stats: SameAsLastStats = { slots: 0, marked: 0, duplicates: 0, written: 0, bytes: 0, refusal: null }

  constructor(private readonly fps: number) {}

  private slotOf(timestamp: number): number {
    return Math.round(timestamp * this.fps)
  }

  /** The render: this slot draws the same picture as the slot before it. */
  markDuplicate(timestamp: number): void {
    this.stats.marked++
    this.duplicateSlots.add(this.slotOf(timestamp))
  }

  /**
   * The encoder, before it encodes: may this frame be written instead?
   *
   * A key frame never can — the GOP structure is the file's seek index and is
   * not this task's to move. Nothing can until the encoder's own numbering has
   * been read off a real packet, which is what `pocStep` is; that costs the
   * first few frames of a render and nothing after.
   */
  offer(timestamp: number, duration: number, keyFrame: boolean): 'encode' | 'skip' {
    const slot = this.slotOf(timestamp)
    this.stats.slots++
    const duplicate = this.duplicateSlots.delete(slot)
    if (duplicate) this.stats.duplicates++
    const skip = duplicate && !keyFrame && this.armed()
    this.entries.push({
      slot,
      timestamp,
      duration,
      kind: skip ? 'skip' : 'real',
      packet: null,
      meta: undefined,
    })
    return skip ? 'skip' : 'encode'
  }

  /**
   * Everything a picture needs before one may be promised: the stream's own
   * headers, the encoder's picture spacing, and a P slice to copy the
   * quantizer from. Promising one and then not writing it would SHORTEN the
   * file, so this is checked before the offer and never after.
   */
  private armed(): boolean {
    return (
      this.stats.refusal === null &&
      this.sps !== null &&
      this.pps !== null &&
      this.pocStep !== null &&
      this.lastPTail !== null &&
      // AND THIS GOP'S OWN NUMBERING HAS SETTLED. Measured 2026-09-08: with
      // only the render-start guard, every GOP lost its first few odd slots —
      // the gate found 3 per GOP, always at slots 3, 5 and 7 after the key
      // frame, and nowhere else. A key frame resets frame_num and the picture
      // order, and the P slice this copies its quantizer and deblocking from
      // belongs to the GOP before it until a real P packet of THIS one has been
      // bound. So the same rule that costs the first frames of a render costs
      // the first frames of a GOP: two real pictures since the key frame, then
      // arm. At a 2.5 s GOP that is ~2 % of the duplicates and it is the
      // difference between a picture that is exact and one that is nearly.
      this.realsSinceIdr >= 2
    )
  }

  /**
   * The encoder's own output. Binds the packet to the earliest real slot still
   * waiting for one, then drains everything the file can already have.
   */
  onPacket(
    packet: EncodedPacket,
    meta: unknown,
    emit: (packet: EncodedPacket, meta?: unknown) => void,
  ): void {
    this.learn(meta)
    const entry = this.entries.find((e) => e.kind === 'real' && e.packet === null)
    if (!entry) {
      // Nothing to bind it to: pass it through rather than lose it. This is the
      // shape of a bug, so it says so once and the render carries on.
      if (!this.stats.refusal) this.stats.refusal = 'a packet arrived with no slot waiting for it'
      emit(packet, meta)
      return
    }
    entry.packet = packet
    entry.meta = meta
    this.drain(emit)
  }

  /** Everything left, in order — the tail of a render is often a skip. */
  flush(emit: (packet: EncodedPacket, meta?: unknown) => void): void {
    this.drain(emit)
    // A real slot whose packet never arrived would stall the drain. Emit what
    // there is, in order, rather than dropping the pictures queued behind it.
    for (const e of this.entries) {
      if (e.kind === 'real') {
        if (e.packet) emit(this.renumber(e), e.meta)
      } else {
        const written = this.writeSkip(e)
        if (written) emit(written)
      }
    }
    this.entries.length = 0
  }

  private learn(meta: unknown): void {
    if (this.sps && this.pps) return
    const description = (meta as { decoderConfig?: { description?: BufferSource } } | undefined)
      ?.decoderConfig?.description
    if (!description) return
    const bytes =
      description instanceof ArrayBuffer
        ? new Uint8Array(description)
        : new Uint8Array(
            (description as ArrayBufferView).buffer,
            (description as ArrayBufferView).byteOffset,
            (description as ArrayBufferView).byteLength,
          )
    // An avcC begins with configurationVersion 1; anything else is another
    // codec's description and this engine has no business in that stream.
    if (bytes.length < 7 || bytes[0] !== 1) {
      this.stats.refusal = 'the encoder described itself with something other than an avcC'
      return
    }
    const { sps, pps } = splitAvcC(bytes)
    if (!sps.length || !pps.length) {
      this.stats.refusal = 'the avcC carried no sequence or picture header'
      return
    }
    const parsedSps = parseSps(sps[0])
    const parsedPps = parsePps(pps[0])
    const refusal = skipPictureRefusal(parsedSps, parsedPps)
    if (refusal) {
      this.stats.refusal = refusal
      return
    }
    this.sps = parsedSps
    this.pps = parsedPps
  }

  /**
   * Read the encoder's own picture spacing off a real packet. The first
   * non-key picture of the take answers it exactly and once: its own order
   * value IS the step, with no arithmetic that could wrap.
   */
  private notePoc(header: AvcSliceHeader): void {
    if (this.pocStep !== null) return
    if (this.realsSinceIdr === 1 && header.pic_order_cnt_lsb > 0) {
      this.pocStep = header.pic_order_cnt_lsb
    }
  }

  private drain(emit: (packet: EncodedPacket, meta?: unknown) => void): void {
    for (;;) {
      const head = this.entries[0]
      if (!head) return
      if (head.kind === 'real') {
        if (!head.packet) return
        this.entries.shift()
        emit(this.renumber(head), head.meta)
      } else {
        this.entries.shift()
        const written = this.writeSkip(head)
        if (written) emit(written)
        else if (head.packet) emit(head.packet, head.meta)
      }
    }
  }

  /**
   * A real packet, with its order value moved up by however many pictures have
   * been written before it in this GOP. The encoder numbered its own pictures
   * densely; the FILE numbers slots.
   */
  private renumber(entry: Entry): EncodedPacket {
    const sps = this.sps
    const pps = this.pps
    if (!sps || !pps || !entry.packet) return entry.packet as EncodedPacket
    const packet = entry.packet
    if (packet.type === 'key') {
      this.idrSlot = entry.slot
      this.realsSinceIdr = 0
    }
    const data = packet.data
    const nals = avccNals(data)
    let header: AvcSliceHeader | null = null
    const pieces: Uint8Array[] = []
    let changed = false
    // UNTIL THE SPACING IS KNOWN, NOTHING HAS BEEN INJECTED, so the encoder's
    // own numbering is already the file's — patching it here against a guessed
    // step is how a correct stream would get broken before the engine has even
    // written anything.
    const target = this.pocStep === null
      ? null
      : ((entry.slot - this.idrSlot) * this.pocStep) % maxPicOrderCntLsb(sps)
    for (const { start, end } of nals) {
      const nal = data.subarray(start, end)
      const parsed = parseSliceHeader(nal, sps, pps)
      if (!parsed) {
        pieces.push(nal)
        continue
      }
      if (!header) header = parsed
      if (target !== null && parsed.pic_order_cnt_lsb !== target) {
        pieces.push(setPicOrderCntLsb(nal, sps, parsed, target))
        changed = true
      } else pieces.push(nal)
    }
    if (header) {
      this.notePoc(header)
      this.realsSinceIdr++
      this.lastRealFrameNum = header.frame_num
      if (header.tail) this.lastPTail = header.tail
    }
    if (!changed) return packet
    let length = 0
    for (const p of pieces) length += 4 + p.length
    const out = new Uint8Array(length)
    let at = 0
    for (const p of pieces) {
      out.set(avccWrap(p), at)
      at += 4 + p.length
    }
    return new EncodedPacket(out, packet.type, packet.timestamp, packet.duration)
  }

  /** The 14 bytes. Null when this slot cannot have one after all. */
  private writeSkip(entry: Entry): EncodedPacket | null {
    const sps = this.sps
    const pps = this.pps
    const tail = this.lastPTail
    if (!sps || !pps || !tail || this.pocStep === null) return null
    const nal = buildSkipSlice(
      sps,
      pps,
      {
        // A non-reference picture carries the frame_num of the NEXT reference
        // picture, which is the previous reference picture's plus one — and a
        // run of them all carry the same value, which is what the spec asks
        // for and what makes a run of skips legal.
        frame_num: (this.lastRealFrameNum + 1) % maxFrameNum(sps),
        slice_qp_delta: tail.slice_qp_delta,
        disable_deblocking_filter_idc: tail.disable_deblocking_filter_idc,
      },
      ((entry.slot - this.idrSlot) * this.pocStep) % maxPicOrderCntLsb(sps),
    )
    const data = avccWrap(nal)
    this.stats.written++
    this.stats.bytes += data.length
    return new EncodedPacket(data, 'delta', entry.timestamp, entry.duration)
  }
}

/** Where the plan rides on the encoder config — a symbol, so it cannot collide. */
export const SAME_AS_LAST_KEY = Symbol.for('inout.sameAsLast.plan')

type PlannedConfig = VideoEncoderConfig & { [SAME_AS_LAST_KEY]?: SameAsLastPlan }

/** Stamp a plan onto the config mediabunny built. Pass with `onEncoderConfig`. */
export function markSameAsLast(plan: SameAsLastPlan) {
  return (config: VideoEncoderConfig): void => {
    ;(config as PlannedConfig)[SAME_AS_LAST_KEY] = plan
  }
}

export function planOf(config: VideoEncoderConfig): SameAsLastPlan | null {
  return (config as PlannedConfig)[SAME_AS_LAST_KEY] ?? null
}
