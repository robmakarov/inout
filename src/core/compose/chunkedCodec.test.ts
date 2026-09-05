import { describe, expect, it } from 'vitest'
import { rungOf, sameTrack, type ChunkTrackShape } from './chunkedRender'

/**
 * J8 — THE CONCATENATION READS THE CODEC OFF THE CHUNKS.
 *
 * The defect this pins is not a wrong number, it is a wrong ASSUMPTION: the
 * chunked export opened its one video track with the ladder's codec ('avc')
 * while `render.ts` had encoded the chunks with AV1 under `?colour=all`, and
 * the muxer answered "Couldn't extract an AVCDecoderConfigurationRecord from
 * the AVC packet". The rules below are the whole of the fix that can be tested
 * without a browser: which track gets opened, which sets are refused, and what
 * the file then says it is.
 */

const avc = (description: Uint8Array, codec = 'avc1.640028'): ChunkTrackShape => ({
  codec: 'avc',
  config: { codec, description } as VideoDecoderConfig,
})

/** AV1 tracks carry NO description — the muxer builds av1C from the string. */
const av1 = (codec: string): ChunkTrackShape => ({
  codec: 'av1',
  config: { codec } as VideoDecoderConfig,
})

const AVC_C = new Uint8Array([1, 100, 0, 40, 255, 225])
const AVC_C_OTHER = new Uint8Array([1, 100, 0, 41, 255, 225])
/** What fullColour.ts asks for, as mediabunny prints it back off the av1C. */
const AV1_444 = 'av01.1.08M.08.0.000.01.01.01.0'
/** What the same encoder prints for the 4:2:0 profile — the default tail is trimmed. */
const AV1_420 = 'av01.0.08M.08'

describe('a chunk set that does not agree is refused, never muxed', () => {
  it('takes a set whose chunks are the same encode', () => {
    expect(sameTrack(avc(AVC_C), avc(AVC_C))).toBeNull()
    expect(sameTrack(av1(AV1_444), av1(AV1_444))).toBeNull()
  })

  it('refuses AV1 packets against an AVC reference — the failure J8 was opened for', () => {
    expect(sameTrack(av1(AV1_444), avc(AVC_C))).toBe('is av1 where the first chunk is avc')
    expect(sameTrack(avc(AVC_C), av1(AV1_444))).toBe('is avc where the first chunk is av1')
  })

  it('refuses 4:2:0 AV1 against 4:4:4 AV1, which NO description can tell apart', () => {
    // Both sides have `description: undefined`, so the avcC test J1 shipped
    // passes them both. The codec string is the only thing that differs, and
    // it is what the muxer turns into av1C.
    expect(sameTrack(av1(AV1_420), av1(AV1_444))).toBe(
      `is encoded as ${AV1_420} where the first chunk is ${AV1_444}`,
    )
  })

  it('still refuses two AVC chunks whose avcC differs — J1’s original rule', () => {
    expect(sameTrack(avc(AVC_C_OTHER), avc(AVC_C))).toBe(
      'has a different decoder description than the first',
    )
  })
})

describe('the file says which rung it actually is', () => {
  const ladder = { rung: 'avc', videoCodec: 'avc' } as const

  it('is the ladder rung when the chunks are the ladder codec', () => {
    expect(rungOf(ladder, avc(AVC_C))).toBe('avc-chunked')
  })

  it('names the 4:4:4 swap in render.ts’s own words when the chunks are AV1 profile 1', () => {
    expect(rungOf(ladder, av1(AV1_444))).toBe('avc→av1-444-sw-chunked')
  })

  it('does not call a 4:2:0 AV1 chunk 4:4:4 — the profile is read, not assumed', () => {
    expect(rungOf(ladder, av1(AV1_420))).toBe('avc→av1-chunked')
  })
})

/**
 * THE DECLINE IS GONE, AND ITS ABSENCE IS THE TASK. Asserted on the source in
 * the style of gateFlag.test.ts, because "renderChunked no longer refuses full
 * colour" is a claim about which code exists: put the guard back and every
 * behavioural test here still passes while the edit loop silently re-renders
 * whole takes again (9533.9 ms against 2729.5 ms on a 30 s take, O9(b)).
 */
const SOURCE = import.meta.glob('/src/{core,app}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('the chunked path does not refuse full colour any more', () => {
  const chunked = SOURCE['/src/core/compose/chunkedRender.ts']!

  it('has no `flags.fullColour` guard left in it', () => {
    expect(chunked).not.toMatch(/if\s*\(flags\.fullColour\)/)
  })

  it('opens its track and its certificate from the chunk, not from the ladder', () => {
    expect(chunked).toContain('new EncodedVideoPacketSource(reference.codec)')
    expect(chunked).toContain('video: reference.codec')
    expect(chunked).toContain('rung: rungOf(target, reference)')
    // The ladder still decides the CONTAINER and the audio codec — only the
    // video track's codec moved.
    expect(chunked).toContain('format: target.format')
  })

  it('checks every chunk after the first against it', () => {
    expect(chunked).toContain('const disagreement = sameTrack(opened, reference)')
    expect(chunked).toContain('throw new ChunkedRenderUnavailable(`chunk ${chunk.index} ${disagreement}`)')
  })
})
