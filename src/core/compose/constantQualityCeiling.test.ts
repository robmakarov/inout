/**
 * Q1's gate: THE EXPORT HAS NO BYTE CEILING, AND NOTHING MAY QUIETLY ADD ONE.
 *
 * Robert 2026-09-02 (DECISIONS robert (16)), asked whether one was needed at
 * all: "we need or not? if file gets to big you are just going fix it other
 * ways". Quantizer mode now means what its name says — the QP is set once from
 * the config and the size follows the content.
 *
 * This is a SOURCE test for the same reason J3's is (prerenderTrigger.test.ts):
 * the behaviour is an ABSENCE. A governor that comes back would not fail any
 * behavioural test — it would just quietly soften somebody's motion-heavy
 * export mid-file, which is exactly the thing the ruling forbids and exactly
 * the thing nobody would notice in a green suite.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_QP, clampQp } from './constantQuality'

const composeSources = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Comments and strings out: this file argues about the ruling at length. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const encoderSource = (): string => {
  const hit = Object.entries(composeSources).find(([f]) => f.endsWith('constantQuality.ts'))
  expect(hit, 'constantQuality.ts must be in the scanned set').toBeTruthy()
  return code(hit![1])
}

describe('Q1 — the constant-quality encoder holds its QP', () => {
  it('reads the modules it is gating', () => {
    // A glob that came back empty would pass everything below by looking at
    // nothing at all (note 17: a gate that cannot fail is not a gate).
    expect(Object.keys(composeSources).length).toBeGreaterThan(20)
  })

  it('never moves the QP after init — no governor, by any name', () => {
    // The deleted shape: any assignment to this.qp outside init(). init sets it
    // twice (the config's value, and 0 for the configure-time fallback), so the
    // count is what is pinned, not the mere presence.
    const assignments = encoderSource().match(/this\.qp\s*=/g) ?? []
    expect(assignments.length).toBe(2)
  })

  it('keeps no running byte total to govern against', () => {
    const src = encoderSource()
    for (const gone of ['bytesPerSecCeiling', 'MAX_GOVERNED_QP', 'targetQp', 'bytesOut', 'spend(']) {
      expect(src, `${gone} is the deleted governor`).not.toContain(gone)
    }
  })

  it('does not read a bitrate back out of the config as a ceiling', () => {
    // `bitrate` is still DESTRUCTURED AWAY before configure — quantizer mode
    // rejects the pair — and that use is the only legitimate one left here.
    const src = encoderSource()
    // `bitrateMode` is the mode switch and is not a ceiling; what must not come
    // back is `bitrate` READ AS A NUMBER. The two that remain are the
    // destructure that throws it away and its type annotation.
    const uses = src.match(/bitrate(?!Mode)/g) ?? []
    expect(uses.length).toBe(2)
    expect(src).toContain('const { bitrate, ...rest }')
    // The governor's arithmetic: bits per second into bytes per second.
    expect(src).not.toMatch(/bitrate[^\n]*\/\s*8/)
  })

  it('catches the shape it is meant to catch', () => {
    // Born red against the deleted lines themselves, so this is known to fail.
    const deleted = code(`
      private spend(bytes: number, timestampUs: number): void {
        this.bytesOut += bytes
        const over = this.bytesOut / this.bytesPerSecCeiling
        if (over > 1.15 && this.qp < MAX_GOVERNED_QP) this.qp = clampQp(this.qp + 1)
        else if (over < 0.85 && this.qp > this.targetQp) this.qp = clampQp(this.qp - 1)
      }
    `)
    expect((deleted.match(/this\.qp\s*=/g) ?? []).length).toBe(2)
    expect(deleted).toContain('bytesPerSecCeiling')
    expect(deleted).toContain('MAX_GOVERNED_QP')
  })

  it('still clamps a QP to what H.264 defines', () => {
    // The clamp is not the ceiling and does not go with it: a config outside
    // 1..51 is a crash, not a size policy.
    expect(clampQp(0)).toBe(1)
    expect(clampQp(99)).toBe(51)
    expect(clampQp(DEFAULT_QP)).toBe(DEFAULT_QP)
  })
})
