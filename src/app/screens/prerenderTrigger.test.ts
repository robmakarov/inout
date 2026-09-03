/**
 * J3's gate: NO CODE PATH STARTS A RENDER FROM AN EDIT.
 *
 * Robert, 2026-09-03 (robert (23)): "render in background while editing is
 * fucked up, it goes back and forth and it wastage of resourses, i dont want
 * it". The deleted code was one `setTimeout(() => startPrerender(...), 1200)`
 * in the editor, and one line is exactly the kind of thing that comes back —
 * so this reads the shipped source and fails if it does.
 *
 * It is deliberately a SOURCE test rather than a behavioural one. The
 * behaviour it guards is an ABSENCE, and the honest way to gate an absence is
 * to look for the thing that must not be there; a render-started-by-accident
 * would otherwise only show up as a slow machine on somebody's long take,
 * which is how it got here in the first place.
 */
import { describe, expect, it } from 'vitest'

const appSources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const coreSources = import.meta.glob('../../core/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Comments and strings out: these files argue about the ruling at length. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

describe('J3 — nothing renders because of an edit', () => {
  it('reads the modules it is gating', () => {
    // A glob that came back empty would pass every assertion below by looking
    // at nothing at all (note 17: a gate that cannot fail is not a gate).
    expect(Object.keys(appSources).length).toBeGreaterThan(10)
    expect(Object.keys(coreSources).length).toBeGreaterThan(20)
    const editor = Object.entries(appSources).find(([f]) => f.endsWith('EditorScreen.tsx'))
    expect(editor, 'EditorScreen.tsx must be in the scanned set').toBeTruthy()
  })

  it('the EDITOR never calls startPrerender', () => {
    // Scoped to the editor on purpose: the capture screen still starts the
    // at-stop job, and that one is not speculation — it runs once, when the
    // machine is idle by definition, and the gate below pins that it stays.
    const offenders = Object.entries(appSources)
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([file]) => /screens\/EditorScreen\.tsx$|components\//.test(file))
      .filter(([, text]) => /\bstartPrerender\s*\(/.test(code(text)))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('no app or core module starts a render on a timer', () => {
    // The deleted shape exactly: a deferred call into the pre-render.
    const deferred = /set(?:Timeout|Interval)\([^;]{0,200}?startPrerender/
    const offenders = [...Object.entries(appSources), ...Object.entries(coreSources)]
      // Tests are excluded, and this one is why: the born-red assertion below
      // carries the forbidden shape as a regex literal, so a scan that included
      // itself would fail forever on its own gate.
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([, text]) => deferred.test(code(text).replace(/\s+/g, ' ')))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('catches the shape it is meant to catch', () => {
    // Born red against the line J3 deleted, so this is known to be able to fail.
    const deleted = 'const t = setTimeout(() => startPrerender({ recording, edit, settings }), 1200)'
    expect(/\bstartPrerender\s*\(/.test(code(deleted))).toBe(true)
    expect(/set(?:Timeout|Interval)\([^;]{0,200}?startPrerender/.test(code(deleted).replace(/\s+/g, ' '))).toBe(
      true,
    )
  })

  it('the AT-STOP render is untouched — J3 deleted speculation, not the feature', () => {
    // The gate is "press-to-first-byte on an unedited take unchanged", and that
    // is the at-stop job (F16b) doing its work while the machine is idle.
    const capture = Object.entries(appSources).find(([f]) => f.endsWith('CaptureScreen.tsx'))
    expect(capture).toBeTruthy()
    expect(code(capture![1])).toMatch(/startPrerender\(/)
  })
})
