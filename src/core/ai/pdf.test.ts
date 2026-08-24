import { describe, expect, it } from 'vitest'
// @ts-expect-error — the verifier is a node-only .mjs tool with no types by design.
import { parsePdf } from '../../experimental/tools/pdf-verify.mjs'
import { PdfWriter, pdfEscape, textUnits, wrapText, type PdfSink } from './pdf'

interface Parsed {
  ok: boolean
  errors: string[]
  version: string | null
  pageCount: number
  pages: { width: number; height: number; text: string; images: { width: number; height: number; filter: string }[] }[]
  text: string
}

function collector(): { sink: PdfSink; bytes(): Uint8Array } {
  const chunks: Uint8Array[] = []
  return {
    sink: {
      write(b) {
        chunks.push(b.slice())
        return Promise.resolve()
      },
    },
    bytes() {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      return out
    },
  }
}

/** Smallest thing a reader will accept as a JPEG stream: SOI … EOI. */
const fakeJpeg = (n = 64): Uint8Array => {
  const b = new Uint8Array(n)
  b[0] = 0xff
  b[1] = 0xd8
  b[n - 2] = 0xff
  b[n - 1] = 0xd9
  return b
}

async function build(): Promise<Parsed> {
  const c = collector()
  const pdf = new PdfWriter(c.sink)
  await pdf.open()
  const view = await pdf.addJpeg(fakeJpeg(), 1024, 576)
  const crop = await pdf.addJpeg(fakeJpeg(32), 300, 200)
  pdf.addImagePage(view, null, [{ text: 't=0.00s', size: 11 }])
  pdf.addImagePage(view, crop, [{ text: 't=1.50s - change at cursor (100%)', size: 11 }])
  // The index is authored LAST and read FIRST — the whole reason pages and
  // objects are ordered independently.
  pdf.addTextPage(['INOUT recording - index', 'duration 12.00s', 'p2 t=0.00s'], { front: true })
  await pdf.close('Screen recording, 12.0s, 2 frames', 'One screen recording as a document')
  return parsePdf(c.bytes()) as Parsed
}

describe('pdf writer', () => {
  it('produces a file an independent reader accepts', async () => {
    const doc = await build()
    expect(doc.errors).toEqual([])
    expect(doc.ok).toBe(true)
    expect(doc.version).toBe('1.4')
    expect(doc.pageCount).toBe(3)
  })

  it('puts the index first even though it was written last', async () => {
    const doc = await build()
    expect(doc.pages[0]!.text).toContain('INOUT recording - index')
    expect(doc.pages[0]!.images).toHaveLength(0)
    expect(doc.pages[1]!.text).toContain('t=0.00s')
  })

  it('gives every keyframe page its own image plus one caption band — no padding', async () => {
    const doc = await build()
    // 11 pt caption ⇒ a 22 pt band; the picture itself is never covered.
    const band = 22
    expect(doc.pages[1]!.width).toBe(1024)
    expect(doc.pages[1]!.height).toBe(576 + band)
    // The crop stacks under the view at native size: page height is the sum.
    expect(doc.pages[2]!.width).toBe(1024)
    expect(doc.pages[2]!.height).toBe(576 + 200 + band)
    expect(doc.pages[2]!.images.map((i) => `${i.width}x${i.height} ${i.filter}`)).toEqual([
      '1024x576 DCTDecode',
      '300x200 DCTDecode',
    ])
  })

  it('captions are real text, extractable without looking at a pixel', async () => {
    const doc = await build()
    expect(doc.text).toContain('t=1.50s - change at cursor (100%)')
  })

  it('escapes what would otherwise end a PDF string', () => {
    expect(pdfEscape('a (b) \\c')).toBe('a \\(b\\) \\\\c')
    expect(pdfEscape('café — dash')).toBe('caf? ? dash')
  })

  it('wraps by rendered width, not by character count', () => {
    expect(wrapText('short', 20)).toEqual(['short'])
    expect(wrapText('one two three four five', 10)).toEqual(['one two', 'three four', 'five'])
    // Capitals are ~30 % wider in Helvetica, and counting characters is what
    // pushed the index's shouted line off the right edge of the page.
    expect(textUnits('SHOUT')).toBeGreaterThan(textUnits('shout'))
    expect(wrapText('SHOUTING WORDS HERE', 10)).toEqual(['SHOUTING', 'WORDS', 'HERE'])
  })
})
