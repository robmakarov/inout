/**
 * WHAT THE BROWSER TOLD US LAST TIME, remembered so the next take does not
 * have to ask again at the worst possible moment.
 *
 * The concurrent-with-picker start is the whole reason a take can begin the
 * instant the user picks a surface: the mic and camera are supposed to spend
 * the seconds the user is reading Chrome's picker opening themselves, so that
 * when the picker closes there is nothing left to wait for. It only works if
 * getUserMedia is DISPATCHED while the picker is open — and it was gated
 * behind `await navigator.permissions.query(...)`, an IPC to the browser
 * process, which is the process currently busy putting a modal picker on the
 * screen. Whenever that answer came back late the whole optimisation
 * evaporated silently: the mic started AFTER the picker, its full hardware
 * spin-up landed on the user's clock, and the arming line sat on "Waiting for
 * microphone…" over a screen that was already being shared (PO 2026-08-24,
 * "why the fuck waiting is happening").
 *
 * A cached grant lets the request go out in the SAME TICK as the picker, with
 * nothing in front of it. Being wrong is cheap and self-correcting: the live
 * `permissions.query` still runs and still decides the TIMEOUT BUDGET (the raw
 * promise is already in flight by then), so a permission revoked since the
 * last take gets its full human budget for the prompt, exactly as before. The
 * cache only ever decides WHEN to ask, never what to believe.
 *
 * Not a permission store and never treated as one: the browser remains the
 * only authority, and a stale `true` costs one getUserMedia that prompts.
 */

export type DeviceGrant = 'camera' | 'microphone'

const KEY = 'inout.grants.v1'

/** Mirror of the stored map. Also the whole store when localStorage is refused. */
const known: Partial<Record<DeviceGrant, boolean>> = {}
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      if (typeof o.camera === 'boolean') known.camera = o.camera
      if (typeof o.microphone === 'boolean') known.microphone = o.microphone
    }
  } catch {
    /* private mode, file://, corrupt value — memory-only is fine */
  }
}

/**
 * True only when this browser has ALREADY handed us this device without a
 * prompt. Deliberately conservative: unknown reads as "not granted", which
 * falls back to the old order (probe, then ask after the picker) so a
 * first-time user never gets a permission bubble hidden behind the picker.
 */
export function knownGranted(kind: DeviceGrant): boolean {
  load()
  return known[kind] === true
}

export function rememberGrant(kind: DeviceGrant, granted: boolean): void {
  load()
  if (known[kind] === granted) return
  known[kind] = granted
  try {
    localStorage.setItem(KEY, JSON.stringify(known))
  } catch {
    /* memory-only */
  }
}

/**
 * Ask the browser at mount, long before any click, so even the FIRST take of a
 * session dispatches concurrently. Touches no device — `permissions.query` is
 * a lookup, not an acquisition, and the product rule it must respect (no
 * camera or mic before the record click) is about getUserMedia.
 */
export async function primeGrants(): Promise<void> {
  await Promise.all(
    (['camera', 'microphone'] as const).map(async (kind) => {
      try {
        const st = await navigator.permissions.query({ name: kind as PermissionName })
        rememberGrant(kind, st.state === 'granted')
        // Revoked in site settings mid-session: stop claiming it is granted.
        st.onchange = () => rememberGrant(kind, st.state === 'granted')
      } catch {
        /* Safari has no query() for these — the old order stays the fallback */
      }
    }),
  )
}
