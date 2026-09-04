import { describe, expect, it } from 'vitest'
import { index, rewrite, specs } from '../../scripts/flags-doc.mjs'
import { SWITCHES } from './switches'

/**
 * docs/FLAGS.md's index is generated, so it can go stale in exactly one way:
 * someone changes the registry and does not re-run the generator. This is the
 * gate for that — it fails `npm test`, so the push gate refuses it.
 *
 * Read through the bundler, not `node:fs`: this project has no @types/node and
 * `npm run typecheck` is one of the gates (doorOnly.test.ts carries the note).
 */
const RAW = import.meta.glob('/{src/core/switches.ts,docs/FLAGS.md}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const REGISTRY = RAW['/src/core/switches.ts']!
const DOC = RAW['/docs/FLAGS.md']!

describe('docs/FLAGS.md is written from the registry', () => {
  it('reads every row out of the registry source', () => {
    expect(specs(REGISTRY).map((s) => s.id)).toEqual(SWITCHES.map((s) => s.id))
  })

  it('is up to date — re-run `node scripts/flags-doc.mjs` if this fails', () => {
    expect(rewrite(DOC, index(specs(REGISTRY)))).toBe(DOC)
  })

  it('names every switch, so nothing can be documented nowhere', () => {
    const missing = SWITCHES.filter((s) => !DOC.includes(`?${s.id}=`)).map((s) => s.id)
    expect(missing).toEqual([])
  })
})
