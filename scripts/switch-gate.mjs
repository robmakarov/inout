#!/usr/bin/env node
/**
 * THE COUNT ONLY GOES DOWN — U4 part 4, and it is a REFUSED PUSH, not advice.
 *
 * Parts 1-3 of U4 are a one-off tidy: a registry, a state line, a panel that
 * shows everything. Without this they decay in a month, because adding a switch
 * is always the cheapest way to finish a task and nobody is counting.
 *
 * So: `scripts/build-gate.sh` runs this on every push, comparing the pushed
 * commit against what prod is serving. A commit that carries MORE switches than
 * the baseline is refused, and so is one that raises `SWITCH_CEILING` — the
 * ceiling exists to be lowered. Adding a switch means retiring one, or Robert
 * saying so (and then the ceiling moves in a commit that says his name).
 *
 *   node scripts/switch-gate.mjs                      # HEAD against origin/main
 *   node scripts/switch-gate.mjs <new-ref> <old-ref>
 *   node scripts/switch-gate.mjs --file a.ts --against b.ts    # two files, for the gate's own test
 *
 * Exit 0: the count did not rise. Exit 2: REFUSED, with what rose and by how
 * much. Exit 1: the gate could not read what it needed (never a silent pass).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REGISTRY = 'src/core/switches.ts'

/** The number of rows and the declared ceiling, out of the registry's source. */
export function countIn(source) {
  const ids = [...source.matchAll(/^ {4}id: '([^']+)',$/gm)].map((m) => m[1])
  const ceiling = /export const SWITCH_CEILING = (\d+)/.exec(source)
  if (!ids.length || !ceiling) return null
  return { count: ids.length, ceiling: Number(ceiling[1]), ids }
}

function atRef(ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${REGISTRY}`], { encoding: 'utf8' })
  } catch {
    return null
  }
}

/** The refusals, as text. Empty means the push may go. */
export function verdict(next, prev) {
  const out = []
  if (!next) return ['the registry could not be parsed in the pushed commit']
  if (next.count > next.ceiling) {
    out.push(`${next.count} switches against a ceiling of ${next.ceiling}`)
  }
  if (prev) {
    if (next.ceiling > prev.ceiling) {
      out.push(`SWITCH_CEILING rose ${prev.ceiling} -> ${next.ceiling}; it only goes down`)
    }
    if (next.count > prev.count) {
      const added = next.ids.filter((id) => !prev.ids.includes(id))
      out.push(
        `${prev.count} switches -> ${next.count}` +
          (added.length ? ` (added: ${added.join(', ')})` : '') +
          '. Retire one, or ask Robert and lower the ceiling in the same commit.',
      )
    }
  }
  return out
}

function main(argv) {
  const fileAt = argv.indexOf('--file')
  let next, prev, where
  if (fileAt !== -1) {
    next = countIn(readFileSync(argv[fileAt + 1], 'utf8'))
    const againstAt = argv.indexOf('--against')
    prev = againstAt === -1 ? null : countIn(readFileSync(argv[againstAt + 1], 'utf8'))
    where = 'two files'
  } else {
    const nextRef = argv[0] ?? 'HEAD'
    const prevRef = argv[1] ?? 'origin/main'
    const nextSrc = atRef(nextRef)
    if (nextSrc === null) {
      console.error(`switch-gate: cannot read ${REGISTRY} at ${nextRef}`)
      return 1
    }
    next = countIn(nextSrc)
    const prevSrc = atRef(prevRef)
    // No baseline is not a failure: the first commit that carries the registry
    // has nothing to be compared against, and the ceiling still bounds it.
    prev = prevSrc === null ? null : countIn(prevSrc)
    where = `${nextRef} against ${prevRef}${prevSrc === null ? ' (no baseline)' : ''}`
  }

  const bad = verdict(next, prev)
  if (bad.length) {
    console.error(`switch-gate: REFUSED — ${where}`)
    for (const line of bad) console.error(`  ${line}`)
    return 2
  }
  console.error(
    `switch-gate: PASS — ${next.count} switches, ceiling ${next.ceiling}` +
      (prev ? `, baseline ${prev.count}` : '') +
      ` (${where})`,
  )
  return 0
}

if (import.meta.url.endsWith(process.argv[1]?.split('/').pop() ?? '\0')) {
  process.exit(main(process.argv.slice(2)))
}
