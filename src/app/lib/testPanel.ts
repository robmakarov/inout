/**
 * THE TEST PANEL SWITCH — one link, and ONLY that link.
 *
 * The panel exists because of Robert, 2026-08-30: "i m tired of your links with
 * parametres, make me one link /?text with panel of settings we testing all the
 * time". The flags all persist to localStorage already; what was missing was
 * somewhere to press them.
 *
 *     https://inout-kappa.vercel.app/?test
 *
 * IT USED TO BE STICKY, AND THAT WAS WRONG — ruled the same day, twice, by the
 * person it happened to. "One link forever" was read as "keep it on forever",
 * so the switch was written to localStorage and stayed on. What that produced:
 * a link opened once followed him into ordinary use, put the settings line on
 * an editing screen he was not testing on, and left him no way to see why —
 * "test setting shown in not test mode now, what the fuck?". An off button was
 * added; the panel was still there on the next plain visit, because an off
 * button only helps someone who knows they need to press it. His ruling:
 * "it must be only in /?test".
 *
 * So test mode now lasts EXACTLY the load it was asked for on. Nothing is
 * remembered, nothing is written, and there is no state to get stuck in: a
 * plain visit to the app is a plain visit, every time, and the bookmark still
 * works the way a bookmark works. That is what "one link" always meant.
 *
 * `?text` is accepted too, because that is what he typed and a panel that does
 * not open is not a panel. `?test=0` still reads as off, so an old link with it
 * in does not turn the panel on.
 *
 * The FLAGS the panel sets are unaffected: they persist exactly as they did.
 * This governs only whether the panel and the editor's settings line are shown.
 */
export function testPanelEnabled(): boolean {
  if (typeof location === 'undefined') return false
  const p = new URLSearchParams(location.search)
  for (const name of ['test', 'text']) {
    if (!p.has(name)) continue
    const v = p.get(name)
    // `?test` with no value is the whole point — a bare switch, nothing to type.
    return v === null || v === '' || v === '1' ? true : v !== '0'
  }
  return false
}

/**
 * This page's URL with the test switch stripped out — what the panel's own off
 * button navigates to. With the switch URL-only, leaving test mode IS removing
 * the parameter; there is nothing else to clear.
 */
export function urlWithoutTestParam(): string {
  if (typeof location === 'undefined') return '/'
  const url = new URL(location.href)
  url.searchParams.delete('test')
  url.searchParams.delete('text')
  return url.pathname + (url.search ? url.search : '') + url.hash
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
    'resamp',
  ]
  const p = new URLSearchParams(location.search)
  return known.filter((k) => p.has(k))
}
