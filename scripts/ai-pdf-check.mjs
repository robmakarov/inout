#!/usr/bin/env node
/**
 * AI1's "any AI can read this" gate.
 *
 * Runs the aiexport rig, saves the PDF it built, and then puts that file
 * through readers that know nothing about how it was written:
 *
 *   1. src/experimental/tools/pdf-verify.mjs — our own INDEPENDENT parser,
 *      which goes through the xref table like a reader does rather than
 *      regex-scanning for objects. Catches the failure a hand-rolled writer
 *      actually has: an offset that does not land on its object.
 *   2. Apple PDFKit, through JXA. A real third-party implementation, already
 *      on every mac, and therefore no download for the PO to approve —
 *      pdftotext/mutool/qpdf are all absent on this machine.
 *
 * "Any AI" starts at "a strict reader accepts it and finds the text", and
 * both of those are checked here on the actual bytes a user would upload.
 *
 * Usage:
 *   node scripts/ai-pdf-check.mjs [--out=docs/qa/ai-export.pdf] [--args='{"shortSec":8}']
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePdf } from '../src/experimental/tools/pdf-verify.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  let out = 'docs/qa/ai-export.pdf'
  let rigArgs = '{"economySec":60,"shortSec":12,"fiducialSec":12,"includePdf":true}'
  let timeout = 900
  let reuse = ''
  for (const a of argv) {
    if (a.startsWith('--out=')) out = a.slice(6)
    else if (a.startsWith('--args=')) rigArgs = a.slice(7)
    else if (a.startsWith('--timeout=')) timeout = Number(a.slice(10))
    else if (a.startsWith('--reuse=')) reuse = a.slice(8)
  }
  return { out: resolve(ROOT, out), rigArgs, timeout, reuse }
}

/**
 * The report goes to a FILE, not a pipe, and that is not a preference.
 * cdp-run.mjs ends with one `process.stdout.write` of the whole report and
 * then exits; on a pipe the kernel buffer is 64 KB and everything past it is
 * lost, which reads as "the rig produced invalid JSON" at byte 65512. A file
 * descriptor is written synchronously, and this report carries a whole PDF.
 */
function runRig(rigArgs, timeout, reportPath) {
  return new Promise((resolvePromise, reject) => {
    const fd = openSync(reportPath, 'w')
    const child = spawn(
      'node',
      [join(ROOT, 'scripts/exp.mjs'), 'aiexport', rigArgs, `--timeout=${timeout}`],
      { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] },
    )
    child.on('error', reject)
    child.on('close', (code) => {
      closeSync(fd)
      if (code !== 0) return reject(new Error(`rig exited ${code}`))
      try {
        resolvePromise(readReport(reportPath))
      } catch (err) {
        reject(new Error(`rig report is not JSON: ${err.message}`))
      }
    })
  })
}

/** npm prints its own banner first; the report is the JSON object after it. */
function readReport(path) {
  const raw = readFileSync(path, 'utf8')
  const at = raw.indexOf('{\n')
  if (at < 0) throw new Error('no JSON report in the rig output')
  return JSON.parse(raw.slice(at))
}

/** Apple PDFKit, via JXA: a reader nobody here wrote. */
function readWithPdfKit(path) {
  const script = `
    ObjC.import('Quartz')
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(${JSON.stringify(path)}))
    if (!doc || doc.isNil()) { JSON.stringify({ ok: false, error: 'PDFKit refused the file' }) }
    else {
      const pages = []
      for (let i = 0; i < doc.pageCount; i++) {
        const p = doc.pageAtIndex(i)
        const b = p.boundsForBox($.kPDFDisplayBoxMediaBox)
        pages.push({
          width: Math.round(b.size.width),
          height: Math.round(b.size.height),
          chars: p.string.js.length,
        })
      }
      const attrs = doc.documentAttributes
      const attr = (k) => { const v = attrs.objectForKey(k); return v && !v.isNil() ? v.js : '' }
      JSON.stringify({
        ok: true,
        pageCount: Number(doc.pageCount),
        pages,
        text: doc.string.js,
        title: attr('Title'),
        subject: attr('Subject'),
      })
    }
  `
  const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(out)
}

const { out, rigArgs, timeout, reuse } = parseArgs(process.argv.slice(2))
let report = null
// The raw report carries the whole PDF as base64; it lives in tmp, and what
// lands next to the file in docs/qa is the evidence without its own payload.
const rawPath = join(tmpdir(), 'inout-ai-export-report.json')
if (reuse) {
  report = readReport(resolve(ROOT, reuse))
} else {
  console.error(`ai-pdf-check: running the rig (${rigArgs})`)
  report = await runRig(rigArgs, timeout, rawPath)
}
if (!report.pdfBase64) {
  console.error('ai-pdf-check: the rig returned no PDF — pass includePdf:true')
  process.exit(2)
}
const bytes = Buffer.from(report.pdfBase64, 'base64')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, bytes)
console.log(`\nfile: ${out} (${(bytes.length / 1024).toFixed(0)} KB)`)

const parsed = parsePdf(bytes)
const kit = readWithPdfKit(out)

const indexText = parsed.pages[0]?.text ?? ''
const results = [
  {
    name: 'independent parser: the file is structurally valid',
    pass: parsed.ok,
    detail: parsed.errors.length ? parsed.errors.join(' · ') : `${parsed.pageCount} pages, ${parsed.objects} objects`,
  },
  {
    name: 'Apple PDFKit accepts the file and finds the same pages',
    pass: kit.ok && kit.pageCount === parsed.pageCount,
    detail: kit.ok ? `PDFKit reads ${kit.pageCount} pages (parser: ${parsed.pageCount})` : kit.error,
  },
  {
    name: 'the index is extractable text, not a picture of text',
    pass: /SCREEN RECORDING/.test(indexText) && /THE FRAMES/.test(indexText),
    detail: `page 1 yields ${indexText.length} chars of text and 0 images`,
  },
  {
    // PO's first real test: the AI opened the file and asked what to do with
    // it. These four phrases are the answer, and they have to survive
    // extraction by a reader that is not ours.
    name: 'the file briefs its own reader: what it is, what the pages are, what to do',
    pass:
      kit.ok &&
      /SCREEN RECORDING/.test(kit.text) &&
      /frames from ONE screen recording, in time order/.test(kit.text) &&
      /HOW TO READ IT/.test(kit.text) &&
      /NO OTHER INSTRUCTION/.test(kit.text),
    detail: kit.ok
      ? `PDFKit extracts ${kit.text.length} chars; first line "${kit.text.split('\n')[0].slice(0, 80)}"`
      : 'n/a',
  },
  {
    name: 'the document says what it is in its metadata, before a page is opened',
    pass: kit.ok && /[Ss]creen recording/.test(kit.title) && /frame/.test(kit.subject),
    detail: kit.ok ? `Title: "${kit.title}" · Subject: "${kit.subject.slice(0, 90)}…"` : 'n/a',
  },
  {
    // Page = its images stacked, plus one caption band of ~22 pt. Anything
    // more is padding an agent pays for and gets nothing back.
    name: 'every keyframe page is its images plus one caption band — no padding',
    pass: parsed.pages.slice(1).every((p) => {
      if (!p.images.length) return false
      const stacked = p.images.reduce((h, i) => h + i.height, 0)
      const widest = Math.max(...p.images.map((i) => i.width))
      // One caption line is a 22 pt band; a cropped page captions two.
      return p.width === widest && p.height - stacked > 0 && p.height - stacked <= 40
    }),
    detail: parsed.pages
      .slice(1, 4)
      .map(
        (p) =>
          `${p.width}x${p.height} ← ${p.images.map((i) => `${i.width}x${i.height} ${i.filter}`).join(' + ')} + ${p.height - p.images.reduce((h, i) => h + i.height, 0)}pt band`,
      )
      .join(' · '),
  },
  {
    name: 'no video track anywhere in the file',
    pass: !/\/Movie|\/Sound|\/RichMedia|\/Screen/.test(bytes.toString('latin1')),
    detail: 'searched for /Movie, /Sound, /RichMedia and /Screen annotations',
  },
  {
    name: 'captions are real text on the keyframe pages',
    pass: parsed.pages.slice(1).every((p) => /t=\d+\.\d\ds/.test(p.text)),
    detail: parsed.pages[1] ? `page 2 caption: "${parsed.pages[1].text.split('\n')[0]}"` : 'no keyframe page',
  },
]

console.log('\n--- reader gates ---')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`)

console.log('\n--- rig gates ---')
for (const [name, g] of Object.entries(report.gates ?? {})) {
  console.log(`${g.pass ? 'PASS' : 'FAIL'}  ${name}\n      ${g.detail}`)
}
console.log('\n--- notes ---')
for (const n of report.notes ?? []) console.log(`  ${n}`)

const failed =
  results.filter((r) => !r.pass).length + Object.values(report.gates ?? {}).filter((g) => !g.pass).length
console.log(`\n${failed === 0 ? 'ALL GATES PASS' : `${failed} GATE(S) FAILED`}`)

const evidence = { ...report, pdfBase64: undefined, readerGates: results, pdfBytes: bytes.length }
writeFileSync(out.replace(/\.pdf$/, '.json'), JSON.stringify(evidence, null, 2))
process.exit(failed === 0 ? 0 : 1)
