/**
 * EXPERIMENTAL — an INDEPENDENT reader for the AI export's PDF (task AI1).
 *
 * The gate is "any AI understands this file", and that starts at "a strict
 * reader accepts it". Nothing on the dev machine reads PDFs from a shell
 * (no pdftotext, no mutool, no qpdf) and installing one is a download Robert
 * owns, so the check is built here instead — deliberately NOT by reusing
 * src/core/ai/pdf.ts, which would only prove the writer agrees with itself.
 *
 * It reads the file the way a reader does: startxref → the cross-reference
 * table → the trailer's /Root → /Pages → /Kids → each page's /Contents and
 * /XObject. Every offset in the table must land on its own `N 0 obj` header,
 * which is the failure mode a hand-rolled writer actually has.
 *
 * Cross-checked against Apple's PDFKit (scripts/ai-pdf-check.mjs) so this
 * parser being lenient cannot pass a file a real reader would reject.
 */

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1')

function findDict(src, from) {
  const start = src.indexOf('<<', from)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < src.length - 1; i++) {
    if (src[i] === '<' && src[i + 1] === '<') {
      depth++
      i++
    } else if (src[i] === '>' && src[i + 1] === '>') {
      depth--
      i++
      if (depth === 0) return { text: src.slice(start, i + 1), start, end: i + 1 }
    }
  }
  return null
}

function dictGet(dict, key) {
  const at = dict.indexOf(`/${key}`)
  if (at < 0) return null
  return dict.slice(at + key.length + 1).trim()
}

function dictNumber(dict, key) {
  const rest = dictGet(dict, key)
  if (rest === null) return null
  const m = /^-?\d+(\.\d+)?/.exec(rest)
  return m ? Number(m[0]) : null
}

function dictRef(dict, key) {
  const rest = dictGet(dict, key)
  if (rest === null) return null
  const m = /^(\d+)\s+(\d+)\s+R/.exec(rest)
  return m ? Number(m[1]) : null
}

function dictArrayRefs(dict, key) {
  const rest = dictGet(dict, key)
  if (rest === null || rest[0] !== '[') return []
  const body = rest.slice(1, rest.indexOf(']'))
  return [...body.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
}

function dictArrayNumbers(dict, key) {
  const rest = dictGet(dict, key)
  if (rest === null || rest[0] !== '[') return []
  return rest
    .slice(1, rest.indexOf(']'))
    .trim()
    .split(/\s+/)
    .map(Number)
}

function unescapePdfText(s) {
  return s.replace(/\\([()\\])/g, '$1')
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ok: boolean, errors: string[], version: string|null, objects: number,
 *   pageCount: number, pages: Array<{width:number,height:number,text:string,images:Array<{width:number,height:number,filter:string,bytes:number}>}>,
 *   text: string}}
 */
export function parsePdf(bytes) {
  const src = latin1(bytes)
  const errors = []
  const version = /^%PDF-(\d\.\d)/.exec(src)?.[1] ?? null
  if (!version) errors.push('no %PDF header')
  if (!src.trimEnd().endsWith('%%EOF')) errors.push('no %%EOF trailer')

  const startxrefAt = src.lastIndexOf('startxref')
  if (startxrefAt < 0) {
    errors.push('no startxref')
    return { ok: false, errors, version, objects: 0, pageCount: 0, pages: [], text: '' }
  }
  const xrefOffset = Number(/startxref\s+(\d+)/.exec(src.slice(startxrefAt))?.[1] ?? -1)
  if (!(xrefOffset >= 0 && xrefOffset < src.length)) errors.push('startxref points outside the file')

  // --- the cross-reference table ------------------------------------------
  const offsets = new Map()
  let cursor = xrefOffset
  if (src.slice(cursor, cursor + 4) !== 'xref') errors.push('startxref does not point at an xref table')
  cursor += 4
  const tail = src.slice(cursor)
  const sections = /^\s*(\d+)\s+(\d+)\s*/.exec(tail)
  if (!sections) errors.push('malformed xref subsection header')
  else {
    const first = Number(sections[1])
    const count = Number(sections[2])
    let at = cursor + sections[0].length
    for (let i = 0; i < count; i++) {
      const entry = src.slice(at, at + 20)
      if (entry.length < 18) {
        errors.push(`xref entry ${first + i} truncated`)
        break
      }
      const m = /^(\d{10}) (\d{5}) ([nf])/.exec(entry)
      if (!m) {
        errors.push(`xref entry ${first + i} is not 20 bytes of "nnnnnnnnnn ggggg n"`)
        break
      }
      if (m[3] === 'n') offsets.set(first + i, Number(m[1]))
      at += 20
    }
  }

  const trailerAt = src.indexOf('trailer', cursor)
  const trailer = trailerAt >= 0 ? findDict(src, trailerAt) : null
  if (!trailer) errors.push('no trailer dictionary')

  const objectAt = (id) => {
    const at = offsets.get(id)
    if (at === undefined) return null
    const header = new RegExp(`^${id}\\s+\\d+\\s+obj`).exec(src.slice(at, at + 32))
    if (!header) {
      errors.push(`object ${id}: xref offset ${at} does not point at "${id} 0 obj"`)
      return null
    }
    return at + header[0].length
  }
  const dictOf = (id) => {
    const at = objectAt(id)
    if (at === null) return null
    return findDict(src, at)?.text ?? null
  }
  const streamOf = (id) => {
    const at = objectAt(id)
    if (at === null) return null
    const dict = findDict(src, at)
    if (!dict) return null
    const length = dictNumber(dict.text, 'Length')
    const streamAt = src.indexOf('stream', dict.end)
    if (streamAt < 0 || length === null) return null
    const from = streamAt + (src[streamAt + 6] === '\r' ? 8 : 7)
    return bytes.slice(from, from + length)
  }

  for (const id of offsets.keys()) objectAt(id)

  // --- catalog → pages -----------------------------------------------------
  const pages = []
  let pageCount = 0
  const rootId = trailer ? dictRef(trailer.text, 'Root') : null
  if (rootId === null) errors.push('trailer has no /Root')
  else {
    const catalog = dictOf(rootId)
    if (!catalog || !catalog.includes('/Catalog')) errors.push('/Root is not a catalog')
    const pagesId = catalog ? dictRef(catalog, 'Pages') : null
    const pagesDict = pagesId !== null ? dictOf(pagesId) : null
    if (!pagesDict) errors.push('catalog has no reachable /Pages')
    else {
      const kids = dictArrayRefs(pagesDict, 'Kids')
      pageCount = dictNumber(pagesDict, 'Count') ?? 0
      if (kids.length !== pageCount) errors.push(`/Count ${pageCount} but ${kids.length} kids`)
      for (const kid of kids) {
        const page = dictOf(kid)
        if (!page) {
          errors.push(`page object ${kid} unreadable`)
          continue
        }
        const box = dictArrayNumbers(page, 'MediaBox')
        const contentsId = dictRef(page, 'Contents')
        const content = contentsId !== null ? streamOf(contentsId) : null
        if (!content) errors.push(`page object ${kid} has no readable /Contents`)
        const body = content ? latin1(content) : ''
        const text = [...body.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)]
          .map((m) => unescapePdfText(m[1]))
          .join('\n')
        const images = []
        for (const m of body.matchAll(/\/(Im\d+)\s+Do/g)) {
          const name = m[1]
          const resources = dictGet(page, 'XObject')
          const idMatch = resources ? new RegExp(`/${name}\\s+(\\d+)\\s+\\d+\\s+R`).exec(resources) : null
          if (!idMatch) {
            errors.push(`page ${kid} draws /${name} with no XObject entry`)
            continue
          }
          const imgId = Number(idMatch[1])
          const img = dictOf(imgId)
          const stream = streamOf(imgId)
          if (!img || !stream) {
            errors.push(`image object ${imgId} unreadable`)
            continue
          }
          const filter = dictGet(img, 'Filter')?.split(/[\s/\]>]/).filter(Boolean)[0] ?? '?'
          // A DCTDecode stream must actually be a JPEG.
          if (filter === 'DCTDecode' && !(stream[0] === 0xff && stream[1] === 0xd8)) {
            errors.push(`image object ${imgId} is declared JPEG but has no SOI marker`)
          }
          images.push({
            width: dictNumber(img, 'Width') ?? 0,
            height: dictNumber(img, 'Height') ?? 0,
            filter,
            bytes: stream.length,
          })
        }
        pages.push({
          width: box[2] ?? 0,
          height: box[3] ?? 0,
          text,
          images,
        })
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    version,
    objects: offsets.size,
    pageCount,
    pages,
    text: pages.map((p) => p.text).join('\n'),
  }
}
