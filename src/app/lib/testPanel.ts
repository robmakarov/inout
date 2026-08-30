/**
 * THE TEST PANEL SWITCH — Robert, 2026-08-30: "i m tired of your links with
 * parametres, make me one link /?text with panel of settings we testing all the
 * time".
 *
 * He is right, and the URLs were mine: every round of this has ended with me
 * handing him another `?sourceres=1&sourcefps=1&quality=max`, which he then has
 * to keep, retype, or lose. The flags all persist to localStorage already — the
 * only thing missing was somewhere to press them.
 *
 * STICKY FROM THE URL, like `?sourceframe=`, and for the same reason: it is
 * meant to be turned on once and stay on. One link, forever:
 *
 *     https://inout-kappa.vercel.app/?test
 *
 * `?test=0` turns it off again. Accepts `?text` too, because that is what he
 * typed and a panel that does not open is not a panel.
 */
const KEY = 'inout.app.testpanel'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const p = new URLSearchParams(location.search)
  for (const name of ['test', 'text']) {
    if (!p.has(name)) continue
    const v = p.get(name)
    // `?test` with no value is the whole point — a bare switch, nothing to type.
    return v === null || v === '' || v === '1' ? true : v === '0' ? false : true
  }
  return null
}

export function testPanelEnabled(): boolean {
  const url = fromSearch()
  if (url !== null) {
    try {
      localStorage.setItem(KEY, url ? '1' : '0')
    } catch {
      /* memory-only: it lasts this load, which is what the URL asked for */
    }
    return url
  }
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/**
 * A URL PARAMETER BEATS THE PANEL, so the panel has to say so rather than lie
 * about the value it is showing. Every flag here reads
 * `search ?? override ?? storage ?? default`, which is right — a link must win
 * for one load — but it means a leftover `&quality=max` in the address bar
 * makes the panel's own switch look broken.
 */
export function urlOverrides(): string[] {
  if (typeof location === 'undefined') return []
  const known = [
    'sourceres',
    'sourcefps',
    'sourceframe',
    'quality',
    'maxladder',
    'nativeres',
    'encoderbudget',
    'resstep',
    'singlegen',
    'rawcodec',
    'engine',
  ]
  const p = new URLSearchParams(location.search)
  return known.filter((k) => p.has(k))
}
