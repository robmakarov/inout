/**
 * NO EDIT MAY START A RENDER — the source gate, back to gating an ABSENCE.
 *
 * THE HISTORY, kept because this file has now been written three ways and each
 * turn was a ruling. J3 (Robert 2026-09-03) gated the absence: no code path may
 * start a render from an edit. He reversed it on 2026-09-04 (robert (27)) once
 * J1 made a superseded render cost one 2.5 s chunk instead of the whole take —
 * "kill the glued copy encoding and do background render while editing" — and
 * J5 built the one door, `core/compose/editRender.ts`. He reversed it again on
 * 2026-09-05: "bg render while edit dont work, fuck it, delete it". The door
 * module, its flag and the `?bgrender=` switch are DELETED, and the absence is
 * what is gated once more.
 *
 * The at-stop pre-render (F16b, CaptureScreen) is untouched and is asserted
 * below, because deleting the edit trigger must not quietly take it too.
 *
 * What can only be gated by READING THE SOURCE is that nobody re-adds the
 * trigger: a `setTimeout(startPrerender)` in a component months from now would
 * pass every behavioural test in the repo while putting J5 back.
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

describe('an edit starts no render — the deleted J5 trigger stays deleted', () => {
  it('reads the modules it is gating', () => {
    // A glob that came back empty would pass every assertion below by looking
    // at nothing at all (note 17: a gate that cannot fail is not a gate).
    expect(Object.keys(appSources).length).toBeGreaterThan(10)
    expect(Object.keys(coreSources).length).toBeGreaterThan(20)
    const editor = Object.entries(appSources).find(([f]) => f.endsWith('EditorScreen.tsx'))
    expect(editor, 'EditorScreen.tsx must be in the scanned set').toBeTruthy()
  })

  it('the door module is gone and nothing imports it', () => {
    const offenders = [...Object.entries(appSources), ...Object.entries(coreSources)]
      // This file names the deleted module in its own history note, so it is
      // excluded for the same reason the timer scan below excludes itself.
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([, text]) => /compose\/editRender(Flag)?['"]/.test(text))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('the EDITOR never starts a render — not directly, not on a timer', () => {
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

  it('NO module starts a render on a timer — the exemption is gone with J5', () => {
    const deferred = /set(?:Timeout|Interval)\([^;]{0,400}?startPrerender/
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
    // Born red against the exact line J5 owned, so this is known to be able to
    // fail rather than merely known to pass.
    const loose = 'const t = setTimeout(() => startPrerender({ recording, edit, settings }), 1200)'
    expect(/\bstartPrerender\s*\(/.test(code(loose))).toBe(true)
    expect(/set(?:Timeout|Interval)\([^;]{0,400}?startPrerender/.test(code(loose).replace(/\s+/g, ' '))).toBe(
      true,
    )
  })

  it('the AT-STOP render is untouched — deleting the edit trigger did not take it', () => {
    const capture = Object.entries(appSources).find(([f]) => f.endsWith('CaptureScreen.tsx'))
    expect(capture).toBeTruthy()
    expect(code(capture![1])).toMatch(/startPrerender\(/)
  })
})
