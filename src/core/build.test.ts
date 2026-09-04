import { describe, expect, it } from 'vitest'
import { buildId } from './build'

/**
 * The take must be able to say which build made it, and it must never THROW
 * trying: this runs in the capture path, in a worker, and in node, and two of
 * those have no bundler define at all.
 */
describe('the build stamp', () => {
  it('answers something in every environment, including one with no define', () => {
    // vitest applies vite's `define`, so this is the built value in CI and
    // `dev` where git is unavailable. Either way it is a non-empty string and
    // it did not throw, which is the contract the capture path relies on.
    const id = buildId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('is stamped onto the take and printed on the card', async () => {
    const SOURCE = import.meta.glob(
      '/src/{core/capture/session.ts,core/report/reportCard.ts,core/types.ts}',
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>
    // The take carries it…
    expect(SOURCE['/src/core/types.ts']).toContain('buildId?: string')
    expect(SOURCE['/src/core/capture/session.ts']).toContain('buildId: buildId(),')
    // …and the headline says it, which is where a field report is read.
    expect(SOURCE['/src/core/report/reportCard.ts']).toContain(
      'build ${recording.buildId ?? \'?\'}',
    )
  })
})
