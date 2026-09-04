#!/usr/bin/env node
/**
 * EVERY URL PARAMETER THE PRODUCT READS — the census U4's gate is built on.
 *
 * The registry in `src/core/switches.ts` is only worth something if nothing can
 * be readable by the app and missing from it. This walks `src/app` and
 * `src/core` (the product; `src/experimental` is rig code that never ships) and
 * prints every parameter name it can prove is read, one per line.
 *
 * It is deliberately dumb and deliberately WIDE — a name it reports that is not
 * a switch is a line in NOT_SWITCHES with a reason, which is cheap; a name it
 * misses is a switch nobody can see, which is the whole defect.
 *
 *   node scripts/switch-census.mjs           # names only
 *   node scripts/switch-census.mjs --where   # names with file:line
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['src/app', 'src/core']

/** `.get('x')` / `.has('x')` on something that is a query string. */
const DIRECT = /\.(?:get|has)\(\s*'([A-Za-z0-9_.-]+)'\s*\)/g
/** `location.search.includes('x')` — how `?synthetic` is read. */
const INCLUDES = /location\.search\.includes\(\s*'([A-Za-z0-9_.-]+)'\s*\)/g
/** A helper that takes the parameter NAME: `search('lateness')`. */
const HELPER = /\b(?:search|param|urlParam|flag)\(\s*'([A-Za-z0-9_.-]+)'\s*\)/g
/** The name handed to a helper that takes the query string first:
 *  `parseSizeParam(search, 'screensize')`. Four harness knobs were invisible
 *  until this line was written. */
const PASSED = /\(\s*(?:location\.)?search\s*,\s*'([A-Za-z0-9_.-]+)'\s*\)/g

/** A union type whose members are parameter names, read through a variable —
 *  `?killenc=` and friends: `type FaultKnob = 'killenc' | 'killworker'`. */
const KNOB_UNION = /type\s+\w*Knob\s*=\s*([^\n]+)/g

function files(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/**
 * A read whose parameter NAME is a variable — `p.get(name)`. It cannot be
 * resolved by looking at the line, and it is exactly how a switch could be
 * added invisibly, so every one of these must be accounted for by name in the
 * registry's DYNAMIC_READS.
 */
const DYNAMIC = /(?:URLSearchParams\([^)]*\)|\bparams|\bsearchParams|\bp)\.(?:get|has)\(\s*([A-Za-z_$][\w$]*)\s*\)/g

const found = new Map()
const dynamic = []
const note = (name, where) => {
  if (!found.has(name)) found.set(name, [])
  found.get(name).push(where)
}

for (const root of ROOTS) {
  for (const file of files(join(repo, root))) {
    const rel = file.slice(repo.length + 1)
    // The registry itself names every parameter; counting it would make the
    // census agree with the registry by construction, which proves nothing.
    if (rel === 'src/core/switches.ts') continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const at = `${rel}:${i + 1}`
        for (const m of line.matchAll(DIRECT)) {
          // Only a query string. `map.get('x')` is not a switch.
          if (!/URLSearchParams|searchParams|\bparams\b|\bsearch\b|\bqs\b|\bp\.(get|has)/.test(line)) continue
          note(m[1], at)
        }
        for (const m of line.matchAll(INCLUDES)) note(m[1], at)
        for (const m of line.matchAll(HELPER)) note(m[1], at)
        for (const m of line.matchAll(PASSED)) note(m[1], at)
        for (const m of line.matchAll(DYNAMIC)) dynamic.push(`${at} (${m[1]})`)
        for (const m of line.matchAll(KNOB_UNION)) {
          for (const k of m[1].matchAll(/'([A-Za-z0-9_.-]+)'/g)) note(k[1], at)
        }
      })
  }
}

export function census() {
  return [...found.keys()].sort()
}
export function censusWhere() {
  return new Map([...found].sort())
}
/** Reads whose parameter name is a variable: `file:line (identifier)`. */
export function dynamicReads() {
  return [...dynamic].sort()
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const where = process.argv.includes('--where')
  for (const [name, at] of censusWhere()) {
    console.log(where ? `${name.padEnd(16)} ${at.join(' ')}` : name)
  }
  if (where && dynamic.length) {
    console.log('\nreads through a variable (each needs a DYNAMIC_READS entry):')
    for (const d of dynamicReads()) console.log('  ' + d)
  }
}
