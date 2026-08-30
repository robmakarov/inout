/**
 * MAY THE EXPORT BE STARTED BEFORE IT IS ASKED FOR? — F16's switch.
 *
 * ON by default. It changes no output: the file a user gets is the same file
 * the same render would have made on demand, byte for byte, because it IS that
 * render — only started earlier. What it changes is WHEN the machine does the
 * work, and that is the whole feature.
 *
 * The frozen rule still applies and is met by construction rather than by a
 * flag: every miss, failure, cancellation or supersession falls straight
 * through to rendering on demand, which is exactly what the export did before
 * this existed. `?prerender=0` turns it off for a load anyway, because a user
 * who wants their machine left alone while they edit should not have to argue
 * with us about it.
 */
const STORAGE_KEY = 'inout.export.prerender'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('prerender')
  return v === '1' ? true : v === '0' ? false : null
}

let override: boolean | null = null

export function setPrerender(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

export function prerenderEnabled(): boolean {
  const url = fromSearch()
  if (url !== null) return url
  if (override !== null) return override
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* storage unavailable — the default stands */
  }
  return true
}
