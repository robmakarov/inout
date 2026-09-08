/**
 * THE CAPTURE SCREEN SAYS NOTHING ABOUT SWITCHES — the source gate for a
 * deletion, in the shape prerenderTrigger.test.ts uses for the same job.
 *
 * U4 part 1 (2026-09-04) put an always-mounted pill bottom-left of the capture
 * screen: "default", or "N changed" in amber, tap for the list and one Reset.
 * It was built on robert (23) — "something turned on and something not, how to
 * stop this shit" — and Robert killed it on 2026-09-08, on a screenshot of the
 * pill reading `1 changed`: "must not be in app this shit". Asked whether the
 * warning should survive for the case it was built for (a sticky switch from an
 * old link, changing takes with nothing on screen saying so), he chose deleted
 * outright. The component, its CSS and its mount are gone.
 *
 * What only a source gate can hold is that nobody quietly mounts it again: a
 * component reading `changedSwitches()` into the capture tree would pass every
 * behavioural test in the repo while putting the pill back.
 *
 * The `/?test` panel is NOT gated away — it keeps its own title line, and that
 * is asserted below so this deletion cannot silently take it too.
 */
import { describe, expect, it } from 'vitest'

const appSources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const styles = import.meta.glob('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Comments and strings out — this file and CaptureScreen.tsx both name the
 *  deleted thing in prose, and prose is not a mount. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// Vite's glob keys are relative to THIS file, so a sibling comes back as
// './TestPanel.tsx' and a screen as '../screens/CaptureScreen.tsx'. Match on
// the basename and the shape of the key stops mattering.
const named = (file: string) => new RegExp(`(^|/)${file.replace('.', '\\.')}$`)
const source = (file: string) => Object.entries(appSources).find(([f]) => named(file).test(f))?.[1]

describe('the switch state line is deleted and stays deleted', () => {
  it('reads the modules it is gating', () => {
    // A glob that came back empty would pass every assertion below by looking
    // at nothing at all (note 17: a gate that cannot fail is not a gate).
    expect(Object.keys(appSources).length).toBeGreaterThan(10)
    expect(Object.keys(styles).length).toBeGreaterThan(0)
    expect(source('CaptureScreen.tsx'), 'CaptureScreen must be scanned').toBeTruthy()
  })

  it('the component is gone and nothing imports it', () => {
    const offenders = Object.entries(appSources)
      .filter(([file]) => !/\.test\.tsx?$/.test(file))
      .filter(([file, text]) => /SwitchLine\.tsx$/.test(file) || /SwitchLine['"]/.test(text))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('its styles are gone too — a dead rule is a mount waiting to happen', () => {
    const offenders = Object.entries(styles)
      .filter(([, text]) => /swline/.test(text))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('the capture screen reads no switch state at all', () => {
    const capture = code(source('CaptureScreen.tsx')!)
    expect(capture).not.toMatch(/\bchangedSwitches\s*\(/)
    expect(capture).not.toMatch(/\bswitchStateLine\s*\(/)
    expect(capture).not.toMatch(/\bresetAllSwitches\s*\(/)
  })

  it('nothing outside the lazy test panel puts the state line on a screen', () => {
    // The editor's settings badge (Robert 2026-08-30, beside the take's warning
    // banners so one screenshot carries both) reads `changedSwitches` and is
    // his own and untouched; the panel itself is only ever on a `/?test` link.
    const allowed = /(^|\/)(SettingsBadge|TestPanel)\.tsx$/
    const offenders = Object.entries(appSources)
      .filter(([file]) => !/\.test\.tsx?$/.test(file) && !allowed.test(file))
      .filter(([, text]) => /\b(changedSwitches|switchStateLine)\s*\(/.test(code(text)))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('catches the shape it is meant to catch', () => {
    // Born red against the exact lines the deleted component owned, so this is
    // known to be able to fail rather than merely known to pass.
    const mount = "import { SwitchLine } from '@app/components/SwitchLine'"
    expect(/SwitchLine['"]/.test(mount)).toBe(true)
    expect(/\bchangedSwitches\s*\(/.test(code('const changed = changedSwitches()'))).toBe(true)
    expect(/swline/.test('.swline__pill { color: var(--warn) }')).toBe(true)
  })

  it('the /?test panel keeps its own line — the deletion did not take it', () => {
    expect(code(source('TestPanel.tsx')!)).toMatch(/switchStateLine\(\)/)
  })
})
