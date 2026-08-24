/**
 * A minimal PDF writer — ours, zero dependencies (task AI1).
 *
 * The AI export is one PDF because that is the only single file every major AI
 * ingests natively as text AND images. Producing one needs a fraction of the
 * format: JPEG images as DCTDecode XObjects, one built-in font for real
 * selectable text, one page per keyframe. That is a few hundred lines, so it
 * stays ours rather than becoming a dependency the capture app has to carry.
 *
 * IT STREAMS, because O1's rule holds here too: a 200-page export must not sit
 * in the heap. Image bytes go to the sink as they arrive and only their offsets
 * are remembered. Everything small — page objects, content streams, the index
 * text, the cross-reference table — is written at close(), which is also why
 * the index page can be page ONE while being authored LAST: object order in the
 * file has nothing to do with page order, the xref decides.
 *
 * Strictness matters more than features here — "any AI" starts at "a valid PDF
 * every strict reader accepts" — so: exact 20-byte xref entries, a real object
 * 0 free head, contiguous object numbers, WinAnsi-safe escaped text.
 */

export interface PdfSink {
  write(bytes: Uint8Array): Promise<void>
}

export interface PdfImage {
  /** Object number of the XObject. */
  id: number
  width: number
  height: number
  bytes: number
}

interface PlacedImage {
  image: PdfImage
  x: number
  y: number
  width: number
  height: number
}

interface CaptionLine {
  text: string
  size: number
}

interface PageSpec {
  width: number
  height: number
  images: PlacedImage[]
  /** Text drawn white on a black band above the picture. */
  caption: CaptionLine[]
  /** Height of that band; 0 when there is no caption. */
  captionHeight: number
  /** Body text lines, drawn from the top down (the index pages). */
  body: { lines: string[]; size: number; leading: number; margin: number } | null
}

const ENC = new TextEncoder()
/** Caption band geometry, shared by the page layout and the content stream. */
const CAPTION_PAD = 4
const CAPTION_LINE = 1.3

/** WinAnsi-safe, escaped for a PDF literal string. */
export function pdfEscape(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`
    else if (code < 32 || code > 126) out += code === 10 ? ' ' : '?'
    else out += ch
  }
  return out
}

/**
 * Width of a character in half-ems, bucketed.
 *
 * Counting CHARACTERS is what put a line off the right edge of the index page:
 * Helvetica's capitals are ~30 % wider than its lower case, and the line that
 * overflowed was the shouted one ("IF YOU WERE HANDED THIS FILE…"). A full AFM
 * table would be exact and is 300 lines of data for a wrap; three buckets are
 * within a few percent and fit in a function.
 */
const NARROW = new Set([...'ijltf.,;:\'"|!()[]{}/\\ -'])
const WIDE = new Set([...'mwMW@%&'])
export function textUnits(text: string): number {
  let units = 0
  for (const ch of text) {
    if (NARROW.has(ch)) units += 0.55
    else if (WIDE.has(ch) || (ch >= 'A' && ch <= 'Z')) units += 1.35
    else units += 1.05
  }
  return units
}

/** Word-wrap to a width in half-ems (see textUnits). */
export function wrapText(text: string, maxUnits: number): string[] {
  if (textUnits(text) <= maxUnits) return [text]
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if (!line) line = w
    else if (textUnits(`${line} ${w}`) <= maxUnits) line += ` ${w}`
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export class PdfWriter {
  private readonly sink: PdfSink
  private offset = 0
  /** Object number → byte offset. Object numbers start at 1. */
  private readonly offsets = new Map<number, number>()
  private nextId = 1
  private readonly pages: PageSpec[] = []
  private opened = false

  constructor(sink: PdfSink) {
    this.sink = sink
  }

  get bytesWritten(): number {
    return this.offset
  }

  get pageCount(): number {
    return this.pages.length
  }

  private async raw(bytes: Uint8Array): Promise<void> {
    await this.sink.write(bytes)
    this.offset += bytes.byteLength
  }

  private async text(s: string): Promise<void> {
    await this.raw(ENC.encode(s))
  }

  private allocate(): number {
    return this.nextId++
  }

  async open(): Promise<void> {
    if (this.opened) throw new Error('pdf: already open')
    this.opened = true
    // The binary comment is what tells a transfer agent this is not text.
    await this.raw(ENC.encode('%PDF-1.4\n'))
    await this.raw(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  }

  /**
   * Stream one JPEG in as an image XObject. The bytes are handed to the sink
   * immediately and never held: this is the only large thing in the file.
   */
  async addJpeg(bytes: Uint8Array, width: number, height: number): Promise<PdfImage> {
    const id = this.allocate()
    this.offsets.set(id, this.offset)
    await this.text(
      `${id} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.byteLength} >>\nstream\n`,
    )
    await this.raw(bytes)
    await this.text('\nendstream\nendobj\n')
    return { id, width, height, bytes: bytes.byteLength }
  }

  /**
   * A page that is its picture plus one caption band: no pixel is padding, so
   * an agent's per-page cost is the picture it asked for and ~30 tokens of
   * band. A crop (when the change is small) stacks under the full view at its
   * native size.
   *
   * THE BAND IS ABOVE THE PICTURE, NOT ON IT. Drawn over the image it cost
   * nothing in page size and covered the top ~20 px of the frame — which on a
   * screen recording is the tab strip, the title bar, the menu: the very row an
   * agent most wants. Twenty pixels of page is the cheaper mistake.
   */
  addImagePage(view: PdfImage, crop: PdfImage | null, caption: CaptionLine[]): number {
    const width = Math.max(view.width, crop?.width ?? 0)
    const captionHeight = caption.length
      ? Math.round(CAPTION_PAD * 2 + caption[0]!.size * CAPTION_LINE * caption.length)
      : 0
    const height = view.height + (crop?.height ?? 0) + captionHeight
    const images: PlacedImage[] = [
      {
        image: view,
        x: 0,
        y: height - captionHeight - view.height,
        width: view.width,
        height: view.height,
      },
    ]
    if (crop) images.push({ image: crop, x: 0, y: 0, width: crop.width, height: crop.height })
    this.pages.push({ width, height, images, caption, captionHeight, body: null })
    return this.pages.length
  }

  /**
   * A text-only page, as tall as its text and no taller. Returned page number
   * is 1-based and reflects `front` — the index is authored last and read
   * first.
   */
  addTextPage(
    lines: string[],
    opts: { size?: number; width?: number; margin?: number; front?: boolean } = {},
  ): number {
    const size = opts.size ?? 9
    const leading = Math.round(size * 1.28 * 100) / 100
    const margin = opts.margin ?? 14
    const width = opts.width ?? 468
    const height = Math.round(margin * 2 + leading * Math.max(1, lines.length))
    const page: PageSpec = {
      width,
      height,
      images: [],
      caption: [],
      captionHeight: 0,
      body: { lines, size, leading, margin },
    }
    if (opts.front) {
      this.pages.unshift(page)
      return 1
    }
    this.pages.push(page)
    return this.pages.length
  }

  private contentFor(page: PageSpec): string {
    const parts: string[] = []
    for (const p of page.images) {
      parts.push(
        `q\n${num(p.width)} 0 0 ${num(p.height)} ${num(p.x)} ${num(p.y)} cm\n/Im${p.image.id} Do\nQ`,
      )
    }
    if (page.caption.length) {
      const size = page.caption[0]!.size
      const lineH = size * CAPTION_LINE
      parts.push(
        `0 0 0 rg\n0 ${num(page.height - page.captionHeight)} ${num(page.width)} ${num(page.captionHeight)} re f`,
      )
      parts.push('1 1 1 rg')
      let y = page.height - CAPTION_PAD - size
      for (const line of page.caption) {
        parts.push(
          `BT\n/F1 ${num(line.size)} Tf\n${CAPTION_PAD + 2} ${num(y)} Td\n(${pdfEscape(line.text)}) Tj\nET`,
        )
        y -= lineH
      }
      parts.push('0 g')
    }
    if (page.body) {
      const { lines, size, leading, margin } = page.body
      let y = page.height - margin - size
      const chunks = ['BT', `/F1 ${num(size)} Tf`]
      for (const line of lines) {
        chunks.push(`1 0 0 1 ${num(margin)} ${num(y)} Tm`, `(${pdfEscape(line)}) Tj`)
        y -= leading
      }
      chunks.push('ET')
      parts.push(chunks.join('\n'))
    }
    return parts.join('\n') + '\n'
  }

  /**
   * Writes every small object, the xref and the trailer.
   *
   * `subject` is not decoration: some readers surface document metadata before
   * a single page is looked at, and this file's whole problem is a reader that
   * does not know what it is holding.
   */
  async close(title: string, subject: string): Promise<void> {
    if (!this.opened) throw new Error('pdf: not open')
    if (this.pages.length === 0) throw new Error('pdf: no pages')

    // Content streams first — they are referenced by the page objects.
    const contentIds: number[] = []
    for (const page of this.pages) {
      const body = this.contentFor(page)
      const bytes = ENC.encode(body)
      const id = this.allocate()
      this.offsets.set(id, this.offset)
      await this.text(`${id} 0 obj\n<< /Length ${bytes.byteLength} >>\nstream\n`)
      await this.raw(bytes)
      await this.text('\nendstream\nendobj\n')
      contentIds.push(id)
    }

    const fontId = this.allocate()
    this.offsets.set(fontId, this.offset)
    await this.text(
      `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
    )

    const pagesId = this.allocate()
    const pageIds = this.pages.map(() => this.allocate())
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]!
      const id = pageIds[i]!
      this.offsets.set(id, this.offset)
      const xobjects = page.images.length
        ? ` /XObject << ${page.images.map((p) => `/Im${p.image.id} ${p.image.id} 0 R`).join(' ')} >>`
        : ''
      await this.text(
        `${id} 0 obj\n<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >>${xobjects} >> ` +
          `/Contents ${contentIds[i]} 0 R >>\nendobj\n`,
      )
    }

    this.offsets.set(pagesId, this.offset)
    await this.text(
      `${pagesId} 0 obj\n<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(' ')}] >>\nendobj\n`,
    )

    const catalogId = this.allocate()
    this.offsets.set(catalogId, this.offset)
    await this.text(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`)

    const infoId = this.allocate()
    this.offsets.set(infoId, this.offset)
    await this.text(
      `${infoId} 0 obj\n<< /Title (${pdfEscape(title)}) /Subject (${pdfEscape(subject)}) ` +
        `/Producer (INOUT) /Creator (INOUT export for AI) >>\nendobj\n`,
    )

    const xrefOffset = this.offset
    const count = this.nextId // object 0 + objects 1..nextId-1
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let id = 1; id < count; id++) {
      const at = this.offsets.get(id)
      if (at === undefined) throw new Error(`pdf: object ${id} was never written`)
      table += `${String(at).padStart(10, '0')} 00000 n \n`
    }
    table += `trailer\n<< /Size ${count} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    await this.text(table)
  }
}
