import { describe, expect, it } from 'vitest'
import { SWITCHES } from '@core/switches'

/**
 * U4's rule, applied to the editor's settings line: it may not be able to name
 * FEWER switches than there are. The first line is hand-written on purpose (it
 * is the take's settings, in the words the take is discussed in), so the test
 * is that everything it hand-names is a real switch and everything else reaches
 * the registry-backed second line.
 *
 * Source-scanned rather than rendered: this project has no DOM test
 * environment, and the thing that can rot is the hand-kept NAMED list, which is
 * text.
 */
const SOURCE = import.meta.glob('/src/app/components/SettingsBadge.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const BADGE = SOURCE['/src/app/components/SettingsBadge.tsx']!

function namedIds(): string[] {
  const block = /const NAMED = new Set\(\[([\s\S]*?)\]\)/.exec(BADGE)
  if (!block) throw new Error('the badge no longer carries a NAMED list')
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('the editor names every switch that is set', () => {
  it('hand-names only switches that exist', () => {
    const ids = new Set(SWITCHES.map((s) => s.id))
    const ghosts = namedIds().filter((id) => !ids.has(id))
    expect(ghosts, `the badge names switches the registry does not have: ${ghosts.join(', ')}`).toEqual([])
  })

  it('sends everything it does not hand-name to the registry line', () => {
    expect(BADGE).toContain('changedSwitches()')
    expect(BADGE).toContain('!NAMED.has(r.spec.id)')
  })

  it('does not drag the live-value bindings into the editor chunk (O7)', () => {
    // The word appears in the file's own note explaining why it is absent, so
    // this looks for an IMPORT of it and not for the string.
    expect(BADGE).not.toMatch(/^import .*switchBindings/m)
  })
})
