/**
 * THERE IS ONE DOOR BETWEEN AN EDIT AND A RENDER — J5's source gate.
 *
 * WHAT THIS FILE USED TO SAY, and why it changed. J3 (Robert 2026-09-03) gated
 * an ABSENCE: no code path may start a render from an edit, scanned for as a
 * `setTimeout(startPrerender)` anywhere in the app. Robert reversed the ruling
 * on 2026-09-04 (robert (27)) once J1 made a superseded render cost one 2.5 s
 * chunk instead of the whole take — "kill the glued copy encoding and do
 * background render while editing" — so the absence is gone and what replaces
 * it is a single, unit-pinned door: `core/compose/editRender.ts`.
 *
 * The rules themselves are behavioural and live in `editRender.test.ts` (an
 * untouched editor renders nothing, a settle, no render for a packet copy, the
 * flag). What can only be gated by READING THE SOURCE is that the door stays
 * the only one — a second `startPrerender` call added to a component months
 * from now would pass every behavioural test in the repo while quietly putting
 * F16's speculative render back.
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

describe('J5 — one door from an edit to a background render', () => {
  it('reads the modules it is gating', () => {
    // A glob that came back empty would pass every assertion below by looking
    // at nothing at all (note 17: a gate that cannot fail is not a gate).
    expect(Object.keys(appSources).length).toBeGreaterThan(10)
    expect(Object.keys(coreSources).length).toBeGreaterThan(20)
    const editor = Object.entries(appSources).find(([f]) => f.endsWith('EditorScreen.tsx'))
    expect(editor, 'EditorScreen.tsx must be in the scanned set').toBeTruthy()
    const door = Object.entries(coreSources).find(([f]) => f.endsWith('compose/editRender.ts'))
    expect(door, 'compose/editRender.ts is the door and must be in the scanned set').toBeTruthy()
  })

  it('the EDITOR goes through the door — it never calls startPrerender itself', () => {
    // Scoped to the editor and its components on purpose: the capture screen
    // still starts the at-stop job, and that one is not speculation — it runs
    // once, when the machine is idle by definition.
    const offenders = Object.entries(appSources)
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([file]) => /screens\/EditorScreen\.tsx$|components\//.test(file))
      .filter(([, text]) => /\bstartPrerender\s*\(/.test(code(text)))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('the editor DOES call the door — the feature is on, not merely allowed', () => {
    // The other half, and the one that matters after robert (27): a fix that
    // ships wired to nothing is the "you did fix and turned it off" defect.
    const editor = Object.entries(appSources).find(([f]) => f.endsWith('EditorScreen.tsx'))!
    expect(code(editor[1])).toMatch(/\bnoteEditorEdit\s*\(/)
    expect(code(editor[1])).toMatch(/\bcancelEditRender\s*\(/)
  })

  it('editRender.ts is the ONLY module that starts a render on a timer', () => {
    // The exact shape J3 deleted, allowed in precisely one file now.
    const deferred = /set(?:Timeout|Interval)\([^;]{0,400}?startPrerender/
    const offenders = [...Object.entries(appSources), ...Object.entries(coreSources)]
      // Tests are excluded, and this one is why: the born-red assertion below
      // carries the forbidden shape as a regex literal, so a scan that included
      // itself would fail forever on its own gate.
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([file]) => !/compose\/editRender\.ts$/.test(file))
      .filter(([, text]) => deferred.test(code(text).replace(/\s+/g, ' ')))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('catches the shape it is meant to catch', () => {
    // Born red against the line J3 deleted and J5 re-homed, so this is known to
    // be able to fail.
    const loose = 'const t = setTimeout(() => startPrerender({ recording, edit, settings }), 1200)'
    expect(/\bstartPrerender\s*\(/.test(code(loose))).toBe(true)
    expect(/set(?:Timeout|Interval)\([^;]{0,400}?startPrerender/.test(code(loose).replace(/\s+/g, ' '))).toBe(
      true,
    )
  })

  it('the AT-STOP render is untouched — J5 added a trigger, it did not move one', () => {
    const capture = Object.entries(appSources).find(([f]) => f.endsWith('CaptureScreen.tsx'))
    expect(capture).toBeTruthy()
    expect(code(capture![1])).toMatch(/startPrerender\(/)
  })
})
