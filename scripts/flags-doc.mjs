#!/usr/bin/env node
/**
 * docs/FLAGS.md's INDEX, WRITTEN FROM THE REGISTRY — U4.
 *
 * FLAGS.md was hand-kept and said 85 switches where the code read 37 of the
 * ones it named, which is the same defect as the panel's hand-kept list: a
 * second place to remember, so a second place to be wrong.
 *
 * It is not simply regenerated whole, because most of that file is MEASURED
 * evidence per flag (what a rung cost, on what take, with numbers) and that is
 * the reason anyone opens it. So the file now has two halves: an INDEX between
 * the markers below, which is generated from `src/core/switches.ts` and must
 * never be edited by hand, and the measured detail underneath, which is written
 * by whoever measured it.
 *
 *   node scripts/flags-doc.mjs           # rewrite the index in place
 *   node scripts/flags-doc.mjs --check   # exit 2 if it is out of date
 *
 * `flagsDoc.test.ts` runs --check, so a stale index fails `npm test` and the
 * push gate refuses it.
 */
// NOTHING IS READ AT IMPORT TIME. `flagsDoc.test.ts` imports the three pure
// functions below and hands them the source through the bundler, because this
// project has no @types/node and `npm run typecheck` is a gate (doorOnly.test.ts
// carries the same note).
export const BEGIN = '<!-- BEGIN GENERATED INDEX — node scripts/flags-doc.mjs; do not edit by hand -->'
export const END = '<!-- END GENERATED INDEX -->'

/** The registry, read as source: this script must not need a bundler. */
export function specs(source) {
  const body = source.slice(source.indexOf('export const SWITCHES'))
  const out = []
  for (const block of body.split(/\n  \{\n/).slice(1)) {
    const field = (name) => {
      const m = new RegExp(`^    ${name}: (.+?),?$`, 'm').exec(block)
      return m ? m[1].replace(/^'|',?$/g, '').replace(/',$/, '') : null
    }
    const id = field('id')
    if (!id) continue
    out.push({
      id,
      storageKey: field('storageKey') === 'null' ? null : field('storageKey'),
      kind: field('kind'),
      options: (field('options') ?? '').match(/'[^']+'/g)?.map((o) => o.slice(1, -1)) ?? null,
      fallback: field('fallback') === 'null' ? null : field('fallback'),
      group: field('group'),
      verdict: field('verdict'),
      label: field('label'),
      hint: field('hint'),
    })
  }
  return out
}

export function index(rows) {
  const groups = [...new Set(rows.map((r) => r.group))]
  const lines = [
    BEGIN,
    '',
    `**${rows.length} switches.** This table is written from \`src/core/switches.ts\` and is the`,
    'whole list: the panel at `/?test` renders the same registry, and `switches.test.ts` walks the',
    'source so a switch cannot exist without a row here. Precedence is URL > sticky > default. The',
    'measured detail for each one is below, written by whoever measured it.',
    '',
    'VERDICT is U4 part 3, the census executed: **fallback** = the frozen rule keeps it (it is the',
    'runtime path we fall back to) · **harness** = an agent needs it to make something fail on',
    'purpose, never a product decision · **product** = it IS a product control and the parameter is',
    'how a rig sets it · **answered** = the question it existed to answer has an answer, and it can',
    'go the day Robert says which way. Only the `answered` rows are his to rule on.',
    '',
  ]
  for (const g of groups) {
    lines.push(
      `### ${g}`,
      '',
      '| Switch | Values | Sticky key | Default | Verdict | What to do with it |',
      '|---|---|---|---|---|---|',
    )
    for (const r of rows.filter((x) => x.group === g)) {
      const values =
        r.options?.join(' \\| ') ??
        (r.kind === 'toggle' ? '1 \\| 0' : r.kind === 'bare' ? '(present)' : `<${r.kind}>`)
      lines.push(
        `| \`?${r.id}=\` — ${r.label} | ${values} | ${r.storageKey ? `\`${r.storageKey}\`` : 'link only'} | ${r.fallback ?? 'derived'} | ${r.verdict} | ${r.hint.replace(/\|/g, '\\|')} |`,
      )
    }
    lines.push('')
  }
  lines.push(END)
  return lines.join('\n')
}

export function rewrite(doc, block) {
  const b = doc.indexOf(BEGIN)
  const e = doc.indexOf(END)
  if (b === -1 || e === -1) {
    // First run: the index goes under the title, above everything hand-written.
    const nl = doc.indexOf('\n')
    return doc.slice(0, nl + 1) + '\n' + block + '\n' + doc.slice(nl + 1)
  }
  return doc.slice(0, b) + block + doc.slice(e + END.length)
}

/** The CLI half, and the only place this file touches the disk. */
async function main() {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const doc = join(repo, 'docs/FLAGS.md')
  const rows = specs(readFileSync(join(repo, 'src/core/switches.ts'), 'utf8'))
  const current = readFileSync(doc, 'utf8')
  const wanted = rewrite(current, index(rows))

  if (process.argv.includes('--check')) {
    if (current !== wanted) {
      console.error('flags-doc: docs/FLAGS.md index is stale — run `node scripts/flags-doc.mjs`')
      return 2
    }
    console.error('flags-doc: PASS — the index matches the registry')
    return 0
  }
  writeFileSync(doc, wanted)
  console.error(`flags-doc: wrote the index for ${rows.length} switches`)
  return 0
}

if (import.meta.url.endsWith(process.argv[1]?.split('/').pop() ?? '\0')) {
  process.exit(await main())
}
