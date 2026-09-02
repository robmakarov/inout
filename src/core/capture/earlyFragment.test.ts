import { describe, expect, it } from 'vitest'
import {
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from 'mediabunny'
import { EARLY_FRAGMENT_S } from './crashFloor'

/**
 * H2b(b) — WHEN THE FIRST PICTURE REACHES DISK.
 *
 * H2's floor probe measured a `kill -9` at 5.4 s salvaging AUDIO ONLY: audio
 * rides ~1 s WebM clusters and already had material, while a fragmented MP4
 * only finalizes a fragment when the current one is longer than the muxer's
 * minimum AND a keyframe arrives — so against a 2 s GOP the whole first two
 * seconds of picture lived in memory and died with the tab.
 *
 * The fix is one extra keyframe at EARLY_FRAGMENT_S plus a minimum below it,
 * and the rule it depends on lives in mediabunny rather than in this repo. So
 * this test asks the muxer itself, through the same two knobs the worker sets:
 * WHEN do bytes first reach the target, and where do the later fragments land.
 * `rawVideo.worker.ts` writes and flushes every chunk the target is handed, so
 * "reached the target" is "reached the platter" for this channel.
 */

/** An avcC shell. Opaque description bytes — nothing here decodes anything. */
const AVCC = new Uint8Array([1, 66, 0, 31, 255, 225, 0, 4, 103, 66, 0, 31, 1, 0, 4, 104, 206, 6, 226])
const FPS = 30
const DT = 1 / FPS

/** Feed a fragmented MP4 four seconds of packets and report, per frame, how
 *  many bytes the target has been handed by then. */
async function writeTake(opts: { minimumFragmentDuration: number; keyEverySec: number; earlySec: number | null }) {
  let bytes = 0
  const sink = new WritableStream<{ data: Uint8Array; position: number }>({
    write(chunk) {
      bytes += chunk.data.byteLength
    },
  })
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: opts.minimumFragmentDuration,
    }),
    target: new StreamTarget(sink),
  })
  const source = new EncodedVideoPacketSource('avc')
  output.addVideoTrack(source, { frameRate: FPS })
  await output.start()

  const timeline: { t: number; bytes: number }[] = []
  let lastKey = -Infinity
  let early = opts.earlySec
  for (let i = 0; i < 4 * FPS; i++) {
    const t = i * DT
    // The worker's own rule: the GOP grid decides first, the early keyframe is
    // ADDED to it, and only a GOP keyframe moves the grid.
    const gopDue = i === 0 || t - lastKey >= opts.keyEverySec
    const earlyDue = !gopDue && early !== null && t >= early
    const key = gopDue || earlyDue
    if (early !== null && t >= early) early = null
    if (gopDue) lastKey = t
    await source.add(
      new EncodedPacket(new Uint8Array(64), key ? 'key' : 'delta', t, DT),
      i === 0
        ? { decoderConfig: { codec: 'avc1.42001f', codedWidth: 320, codedHeight: 240, description: AVCC } }
        : undefined,
    )
    timeline.push({ t, bytes })
  }
  await output.cancel()
  // The header (ftyp+moov) lands before any media; media is what grows it.
  const header = timeline[0].bytes
  return {
    firstMediaAtSec: timeline.find((p) => p.bytes > header)?.t ?? null,
    /** Every instant the file grew — i.e. every fragment that closed. */
    fragmentsAtSec: timeline
      .filter((p, i) => i > 0 && p.bytes > timeline[i - 1].bytes)
      .map((p) => Number(p.t.toFixed(3))),
  }
}

describe('the first video fragment', () => {
  it('reaches disk at the early keyframe, not at the 2 s GOP', async () => {
    const take = await writeTake({
      minimumFragmentDuration: EARLY_FRAGMENT_S / 2,
      keyEverySec: 2,
      earlySec: EARLY_FRAGMENT_S,
    })
    expect(take.firstMediaAtSec).toBe(EARLY_FRAGMENT_S)
  })

  it('costs the LATER fragments nothing — the GOP still decides where they end', async () => {
    const take = await writeTake({
      minimumFragmentDuration: EARLY_FRAGMENT_S / 2,
      keyEverySec: 2,
      earlySec: EARLY_FRAGMENT_S,
    })
    // 1 s, and then EXACTLY the fragments the shipped cadence would have had.
    // That is the point: the early keyframe is added to the GOP grid, never
    // inserted into it, so this file is the shipped one plus one fragment
    // boundary — strictly more decodable at every instant, never less.
    expect(take.fragmentsAtSec).toEqual([1, 2])
  })

  it('is strictly a superset of the shipped cadence, boundary for boundary', async () => {
    const early = await writeTake({
      minimumFragmentDuration: EARLY_FRAGMENT_S / 2,
      keyEverySec: 2,
      earlySec: EARLY_FRAGMENT_S,
    })
    const shipped = await writeTake({ minimumFragmentDuration: 1, keyEverySec: 2, earlySec: null })
    for (const at of shipped.fragmentsAtSec) expect(early.fragmentsAtSec).toContain(at)
    expect(early.fragmentsAtSec.length).toBe(shipped.fragmentsAtSec.length + 1)
  })

  it('?crashfloor=0 is the shipped cadence: nothing decodable before 2 s', async () => {
    const shipped = await writeTake({ minimumFragmentDuration: 1, keyEverySec: 2, earlySec: null })
    // This is the 5.4 s audio-only salvage, in one number.
    expect(shipped.firstMediaAtSec).toBe(2)
    expect(shipped.fragmentsAtSec).toEqual([2])
  })
})
