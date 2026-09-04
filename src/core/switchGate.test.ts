import { describe, expect, it } from 'vitest'
import { countIn, verdict } from '../../scripts/switch-gate.mjs'

/**
 * A GATE THAT CANNOT FAIL IS NOT A GATE (T1's rule, applied to U4 part 4). So
 * this drives `switch-gate.mjs` with a registry that grew and asserts it says
 * no — the same way `npm run drill` proves the commit hook's four refusals.
 */
/* Read through the bundler, not `node:fs` — no @types/node in this project. */
const REAL = (
  import.meta.glob('/src/core/switches.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['/src/core/switches.ts']!

function withRows(source: string, extraIds: string[]): string {
  const rows = extraIds
    .map(
      (id) => `  {
    id: '${id}',
    storageKey: null,
    kind: 'toggle',
    fallback: 'off',
    group: 'Harness',
    label: 'invented for the gate',
    hint: 'this row exists only inside this test, to make the count go up',
  },
`,
    )
    .join('')
  return source.replace(/^]\n/m, rows + ']\n')
}

describe('the switch count only goes down', () => {
  const real = countIn(REAL)!

  it('reads the real registry', () => {
    expect(real.count).toBeGreaterThan(40)
    expect(real.ceiling).toBeGreaterThanOrEqual(real.count)
  })

  it('passes when nothing moved', () => {
    expect(verdict(real, real)).toEqual([])
  })

  it('passes when a switch was retired', () => {
    const culled = countIn(REAL.replace(/^ {4}id: 'camlies',$[\s\S]*?^ {2}},$/m, ''))!
    expect(culled.count).toBe(real.count - 1)
    expect(verdict(culled, real)).toEqual([])
  })

  it('REFUSES a commit that adds a switch', () => {
    const grown = countIn(withRows(REAL, ['newknob']))!
    const said = verdict(grown, real)
    expect(said.join(' ')).toMatch(/newknob/)
    expect(said.length).toBeGreaterThan(0)
  })

  it('REFUSES a commit that raises the ceiling to make room', () => {
    const grown = withRows(REAL, ['newknob']).replace(
      /SWITCH_CEILING = \d+/,
      `SWITCH_CEILING = ${real.ceiling + 1}`,
    )
    const said = verdict(countIn(grown)!, real)
    expect(said.join(' ')).toMatch(/only goes down/)
  })

  it('REFUSES a registry that is already over its own ceiling', () => {
    const over = REAL.replace(/SWITCH_CEILING = \d+/, 'SWITCH_CEILING = 3')
    expect(verdict(countIn(over)!, null).join(' ')).toMatch(/ceiling of 3/)
  })

  it('says so rather than passing when it cannot read the registry', () => {
    expect(countIn('nothing like a registry')).toBeNull()
    expect(verdict(null, real).length).toBe(1)
  })
})
