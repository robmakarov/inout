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

  /**
   * THE ONE WAY THROUGH, and it is his and nobody else's. Before 2026-09-08 the
   * gate's own header promised this exception and the code did not have it, so
   * the only way to land a decision Robert had actually made was to push blind
   * past the gate. Now the ruling rides in the commit message, where the
   * history keeps it.
   */
  describe('a raise Robert ruled', () => {
    const raise = (by = 1) =>
      countIn(
        withRows(REAL, ['newknob']).replace(
          /SWITCH_CEILING = \d+/,
          `SWITCH_CEILING = ${real.ceiling + by}`,
        ),
      )!
    const ruling = (from: number, to: number) =>
      `bump\n\nSWITCH_CEILING ${from} -> ${to}: robert 2026-09-08 "raise the ceiling to ${to}"\n`

    it('passes when the commit carries his words and the exact numbers', () => {
      expect(verdict(raise(), real, ruling(real.ceiling, real.ceiling + 1))).toEqual([])
    })

    it('is REFUSED when the ruling names other numbers — it cannot be copied forward', () => {
      expect(verdict(raise(), real, ruling(real.ceiling + 5, real.ceiling + 6)).join(' ')).toMatch(
        /only goes down/,
      )
    })

    it('is REFUSED when the message only talks about it', () => {
      const said = verdict(raise(), real, 'robert said raise the ceiling to 50, honest')
      expect(said.join(' ')).toMatch(/only goes down/)
    })

    it('authorises the row it was raised for and no more', () => {
      // His one word moves the ceiling by one; a registry that then carries two
      // extra rows is over the new ceiling and is refused on that.
      const two = countIn(
        withRows(REAL, ['newknob', 'anotherknob']).replace(
          /SWITCH_CEILING = \d+/,
          `SWITCH_CEILING = ${real.ceiling + 1}`,
        ),
      )!
      expect(verdict(two, real, ruling(real.ceiling, real.ceiling + 1)).join(' ')).toMatch(
        /against a ceiling of/,
      )
    })

    it('still refuses the raise itself when nothing authorises it', () => {
      expect(verdict(raise(), real, '').join(' ')).toMatch(/only goes down/)
    })
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
