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

/**
 * THE WAY BACK OUT, which this switch shipped without — Robert, 2026-08-30,
 * looking at the settings line on his editing screen: "test setting shown in
 * not test mode now, what the fuck?".
 *
 * He was not misreading it. `?test` is STICKY on purpose — he asked for one
 * link that stays on — but nothing was ever built to turn it off except typing
 * `?test=0`, another URL parameter, which is the exact thing this whole switch
 * existed to spare him. So a link opened once followed him into ordinary use,
 * put a test surface on a screen he was not testing on, and gave him no way to
 * see why or make it stop.
 *
 * That is the same ratchet W1 took out of the wedge ladder: a state a machine
 * can enter by itself and cannot leave by itself is not a setting, it is a
 * trap. A sticky switch needs a visible off, and now it has one.
 */
export function setTestPanelEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* memory-only: the URL below still decides this load */
  }
}

/**
 * This page's URL with the test switch stripped out. Turning the panel off has
 * to leave the address bar clean too: `?test` in the URL WINS over storage on
 * every load (that is the documented precedence), so writing '0' while the
 * parameter is still there would turn itself straight back on at the next
 * refresh — the off button would look broken exactly once and then be
 * disbelieved forever.
 */
export function urlWithoutTestParam(): string {
  if (typeof location === 'undefined') return '/'
  const url = new URL(location.href)
  url.searchParams.delete('test')
  url.searchParams.delete('text')
  return url.pathname + (url.search ? url.search : '') + url.hash
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
