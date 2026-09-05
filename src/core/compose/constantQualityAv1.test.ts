import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AV1_QUANTIZER,
  DEFAULT_QP,
  av1QuantizerFor,
  clampAv1Quantizer,
  clampQp,
} from './constantQuality'

/**
 * J9 — THE AV1 4:4:4 RUNG TAKES A QUALITY TARGET.
 *
 * O9(b)'s `?colour=all` was the last encode in this product still driven by a
 * bitrate, because `constantQualityCodec` answered only for avc. What that
 * cost was invisible until J8 let the chunked path render 4:4:4 at all: the
 * chunked and unbroken lanes produced the same 900 packets 19.5 % apart in
 * bytes and 37.1 dB apart in pixels, because bitrate rate control over twelve
 * 2.5 s segments is not the same rate control over one 30 s stream.
 *
 * Most of the fix is a measurement (see DEFAULT_AV1_QUANTIZER's table). What
 * is testable here is the arithmetic that reaches the encoder, and the two
 * ways it can fail SILENTLY — a wrong clamp and a wrong per-frame key.
 */

describe('the two scales are two scales', () => {
  it('clamps H.264 to 1-51 and AV1 to 0-63 — never one range for both', () => {
    expect(clampQp(0)).toBe(1)
    expect(clampQp(99)).toBe(51)
    expect(clampAv1Quantizer(-5)).toBe(0)
    expect(clampAv1Quantizer(99)).toBe(63)
  })

  it('does not put the measured AV1 rung through the H.264 clamp', () => {
    // The bug this pins: `markConstantQuality` used to clamp to 51, which would
    // have turned the rung the sweep chose (60) into 51 with no error anywhere.
    expect(DEFAULT_AV1_QUANTIZER).toBeGreaterThan(51)
    expect(clampAv1Quantizer(DEFAULT_AV1_QUANTIZER)).toBe(DEFAULT_AV1_QUANTIZER)
    expect(clampQp(DEFAULT_AV1_QUANTIZER)).toBe(51)
  })
})

describe('the dial reaches AV1 through its one measured anchor', () => {
  it('lands the default exactly on the rung the sweep chose', () => {
    expect(av1QuantizerFor(DEFAULT_QP)).toBe(DEFAULT_AV1_QUANTIZER)
  })

  it('is monotonic — a finer H.264 number is a finer AV1 one', () => {
    const rungs = [10, 14, 18, 20, 24, 30].map(av1QuantizerFor)
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]!).toBeGreaterThanOrEqual(rungs[i - 1]!)
  })

  it('flattens at the coarse end instead of overflowing AV1s range', () => {
    // AV1 has no rung coarser than 63, so the top of the H.264 dial clamps.
    // Stated rather than hidden: the alternative is a config a machine rejects.
    expect(av1QuantizerFor(51)).toBe(63)
    expect(av1QuantizerFor(40)).toBe(63)
    expect(av1QuantizerFor(1)).toBe(3)
  })
})

const SOURCE = import.meta.glob('/src/{core,app}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * THE TWO SILENT FAILURES, asserted on the source because neither one throws.
 * A wrong per-frame key is ignored by the encoder — the frame encodes at the
 * implementation default and the file is neither the size nor the quality
 * anyone asked for. A probe of one string while another is encoded is how this
 * feature first reported itself unsupported on hardware that supports it.
 */
describe('nothing about the quality target can fail quietly', () => {
  const cq = SOURCE['/src/core/compose/constantQuality.ts']!
  const render = SOURCE['/src/core/compose/render.ts']!

  it('sends the per-frame quantizer on the codecs own key', () => {
    expect(cq).toContain("this.codec === 'av1'")
    expect(cq).toContain('{ av1: { quantizer: this.qp } }')
    expect(cq).toContain('{ avc: { quantizer: this.qp } }')
  })

  it('offers the encoder to both codecs and no others', () => {
    expect(cq).toContain("const QUANTIZER_CODECS = new Set<VideoCodec>(['avc', 'av1'])")
    expect(cq).toContain('QUANTIZER_CODECS.has(codec) && qpOf(config) !== null')
  })

  it('probes quantizer mode against the SAME string the 4:4:4 rung pinned', () => {
    expect(render).toContain('quantizerModeAccepts(codec444, width, height, \'prefer-software\')')
    // ...and resolves full colour FIRST, or there is no string to probe.
    expect(render.indexOf('const codec444 =')).toBeLessThan(render.indexOf('const cqCodec ='))
  })

  it('translates the dial for AV1 and leaves AVC on its own number', () => {
    expect(render).toContain('codec444 ? av1QuantizerFor(wantQp!) : wantQp')
  })

  it('says which quantizer actually ran, in the rung the certificate carries', () => {
    // `qp` in the certificate is the DIAL (chunkedRender writes flags.cq for
    // the same file), so the rung is the only place the scale is unambiguous.
    expect(render).toContain('av1-444-sw${qp === null ? \'\' : `-q${qp}`}')
  })
})
