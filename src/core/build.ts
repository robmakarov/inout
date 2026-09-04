/**
 * WHICH BUILD IS THIS? — and it is a defect fix, not a nicety.
 *
 * Robert's 71.7-minute take (`rec_yx4mi1or851p`, 2026-09-04) ran a render with
 * ZERO `rchunk-*` files in OPFS, and J1's chunk cache was on. No refusal
 * explained it. The answer was the PWA: J1 merged at 09:52:54, J3 at 09:57:00,
 * and the take STARTED at 10:00:21 — in a tab that had been loaded before those
 * deploys landed, so it ran the pre-J1 build for the next eighty minutes.
 *
 * That is the shape of the problem, and it is not rare: **a long take is always
 * made on an old build**, because the tab has to be open before the take
 * starts, and the service worker serves what it cached. Every field report from
 * a long take is a report about the build the tab was loaded with, and until
 * now nothing in the take said which. A whole class of wrong attribution comes
 * from that — a session reads a take, sees behaviour the code cannot produce,
 * and goes looking for a bug that was fixed hours before the take was made.
 *
 * So the build is stamped on the take, at capture time, and printed on the
 * card. One line, and the question is answered instead of investigated.
 *
 * WHERE THE VALUE COMES FROM. `__INOUT_BUILD__` is replaced at build time by
 * vite (vite.config.ts), from Vercel's own commit sha where there is one and
 * from `git rev-parse` locally. In dev there is no build, so it reads `dev`.
 * It is a plain string on purpose: `src/core/types.ts` stays a leaf, and a
 * value nobody can parse is a value nobody can be wrong about.
 */
declare const __INOUT_BUILD__: string | undefined

/** The commit this bundle was built from — `dev` when it was not built. */
export function buildId(): string {
  try {
    return typeof __INOUT_BUILD__ === 'string' && __INOUT_BUILD__ ? __INOUT_BUILD__ : 'dev'
  } catch {
    // A worker or a test environment where the define never ran.
    return 'dev'
  }
}
