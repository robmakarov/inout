#!/usr/bin/env node
/**
 * O9 — THE COLOUR CEILING, run and written down.
 *
 * Drives `exp o9draw` (src/experimental/perf/drawCeiling.ts), prints the table,
 * writes the A/B pair where Robert looks (`~/Downloads/inout-o9`) and the
 * evidence beside every other gate's (`docs/qa/o9-colour.json`).
 *
 *   node scripts/o9-colour.mjs                 # table + evidence, no files
 *   node scripts/o9-colour.mjs --ab            # + the A/B pair for his eye
 *
 * Heavy: it opens a browser and encodes. Run it through scripts/gate.sh.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const wantAb = process.argv.includes('--ab')
const takeSec = Number((process.argv.find((a) => a.startsWith('--takeSec=')) ?? '').split('=')[1] || 4)

const args = JSON.stringify({ takeSec, artifacts: wantAb })
const out = execFileSync('node', [join(ROOT, 'scripts/exp.mjs'), 'o9draw', args, '--timeout=1800'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
})
const i = out.indexOf('\n{')
const payload = JSON.parse(i >= 0 ? out.slice(i) : out)
const r = payload.result ?? payload

const green = (o) => ((o?.chroma ?? []).find((c) => c.key === 'green')?.keptPct ?? null)
const fr = (o) => (o ? o.edge.chromaFringeMean.toFixed(2) : '-')
const kb = (o) => (o ? Math.round(o.file.bytes / 1024) : '-')

console.log('\nGREEN KEPT (%) and GLYPH CHROMA FRINGE, one still code page, delivered 1920x1080')
console.log('row                     draw   avc   av1 | fringe draw/avc/av1 |  KB avc/av1')
for (const row of r.rows) {
  console.log(
    `${row.id.padEnd(22)} ${String(green(row.drawOnly)).padStart(5)} ${String(green(row.avc420)).padStart(5)} ${String(green(row.av1444)).padStart(5)} |` +
      ` ${row.drawOnly.edge.chromaFringeMean.toFixed(2).padStart(6)} ${fr(row.avc420).padStart(5)} ${fr(row.av1444).padStart(5)} |` +
      ` ${String(kb(row.avc420)).padStart(4)} ${String(kb(row.av1444)).padStart(4)}`,
  )
  if (row.error) console.log(`   ${row.id}: ${row.error}`)
}
console.log('\nWHAT (b) COSTS ON MOVING CONTENT (the still rows flatter it):')
for (const c of r.cost) {
  console.log(`  ${c.id.padEnd(18)} ${c.codec.padEnd(14)} ${String(c.frames).padStart(4)}f ${String(c.ms).padStart(6)}ms ${String(c.fps).padStart(7)}fps ${String(Math.round(c.bytes / 1024)).padStart(6)}KB ${c.error ?? ''}`)
}
console.log()
for (const [k, v] of Object.entries(r.gates)) console.log(`${v.pass ? 'PASS' : 'FAIL'}  ${k}\n      ${v.detail}`)
console.log(`\n${r.verdict}`)

if (r.artifacts && Object.keys(r.artifacts).length) {
  const dir = join(homedir(), 'Downloads', 'inout-o9')
  mkdirSync(dir, { recursive: true })
  const written = []
  for (const [name, url] of Object.entries(r.artifacts)) {
    const b64 = String(url).split(',')[1] ?? ''
    const file = join(dir, name)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    written.push(name)
  }
  console.log(`\nA/B for Robert's eye — ${written.length} files in ${dir}`)
  console.log('  todays-export.* is the rung that ships. every-colour.* is ?colour=all.')
  console.log('  the -4x.png pair is a nearest-neighbour blow-up of the text, which is')
  console.log('  where the difference is actually visible; the .mp4 pair is the same two')
  console.log('  files to scrub. the-screen-itself.png is what was painted.')
  delete r.artifacts
  delete payload.artifacts
}

const dump = join(ROOT, 'docs/qa/o9-colour.json')
mkdirSync(dirname(dump), { recursive: true })
writeFileSync(dump, JSON.stringify(payload, null, 1))
console.log(`\nevidence: ${dump}`)
