import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@app/App'
import { WEDGE_RELOAD_WINDOW_MS, wedgeReloadStamp } from '@app/lib/wedgeReload'
import { appendWedgeJournal, watchBootLiveness } from '@core/capture/wedgeJournal'
import { detectPlatform, evaluateSupport, probeMissingFeatures } from '@core/platform'
import './styles/base.css'

/**
 * DID THE RECOVERY RELOAD LAND — AND DID THE APP STAY ALIVE AFTER IT?
 * Robert, twice (2026-08-25 and 2026-08-30): after the wedge refresh the app
 * "goes unresponsive without any actions", and nothing about it was readable
 * afterwards. Written before the first render on purpose: a boot entry has to
 * survive a render that never happens. See wedgeJournal.ts.
 */
{
  const reloadedAt = wedgeReloadStamp()
  const sinceReload = reloadedAt ? Date.now() - reloadedAt : 0
  if (reloadedAt && sinceReload < WEDGE_RELOAD_WINDOW_MS) {
    appendWedgeJournal({ kind: 'boot', phase: 'script', sinceReloadMs: Math.round(sinceReload) })
    watchBootLiveness(sinceReload)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/**
 * One read-only diagnostic object, present in every build (task P3).
 * The QA matrix runner and a user pasting a console line must see the SAME
 * verdict the app itself acted on — a second parser in the test harness would
 * drift from this one and quietly certify a browser nobody checked.
 */
;(window as unknown as Record<string, unknown>).__inoutSupport = {
  platform: detectPlatform(),
  missing: probeMissingFeatures(),
  support: evaluateSupport(),
}

/**
 * S1 — THE TAKE REPORT CARD, OFF THE MACHINE, WITH ROBERT DOING NOTHING.
 *
 * `__inoutSupport` above is the precedent: one read-only global so an agent and
 * a user's console see the same verdict the app itself computed. These are the
 * same thing for takes. Everything is dynamically imported INSIDE the calls, so
 * none of it — not the store, not the report module — is in the bytes between
 * the user and the record button (O7).
 *
 *   await __inoutReport()          the newest take's card
 *   await __inoutReport('rec_x')   that take's card
 *   await __inoutReport(recording) any take object, without storing it
 *   await __inoutReportAll()       every take still on this machine, newest first
 *   __inoutTakeLog()               the verdict line of every take, including
 *                                  ones since deleted (localStorage ring)
 *   await __inoutEditorReport()    the editor's first 15 s, graded (G7)
 *   await __inoutLateness(5000)    sample this thread here, for that long (G7)
 *
 * The playbook is docs/TAKE_REPORT.md.
 */
{
  const g = window as unknown as Record<string, unknown>
  const evidence = async () => ({
    wedgeJournal: (await import('@core/capture/wedgeJournal')).readWedgeJournal(),
  })
  g.__inoutReport = async (target?: unknown) => {
    const { buildReportCard } = await import('@core/report')
    if (target && typeof target === 'object') {
      return buildReportCard(target as import('@core/types').Recording, await evidence())
    }
    const { recordingsRepo } = await import('@core/store')
    const rows = await recordingsRepo.list()
    const rec =
      typeof target === 'string'
        ? rows.find((r) => r.id === target)
        : [...rows].sort((a, b) => b.createdAt - a.createdAt)[0]
    return rec ? buildReportCard(rec, await evidence()) : null
  }
  g.__inoutReportAll = async () => {
    const { buildReportCard } = await import('@core/report')
    const { recordingsRepo } = await import('@core/store')
    const ev = await evidence()
    return (await recordingsRepo.list())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => buildReportCard(r, ev))
  }
  g.__inoutTakeLog = async () => (await import('@core/report')).readTakeReports()
  /**
   * M1 — THE DOOR'S LEDGER, READABLE WHILE THE TAKE IS STILL RUNNING.
   *
   * `__inoutReport()` reads a take that has STOPPED, off the store. The door's
   * log is the same evidence a second earlier: every change to rate, resolution,
   * quality or which channels run, with who decided it and what became of it.
   * A rig watching an induced load spike needs it live — by the time a take has
   * stopped, the question "did the floor engage before the loss" is a guess.
   *
   *   __inoutDoor()   every decision this session has made, newest last
   */
  g.__inoutDoor = async () => (await import('@core/door')).readDoorLog()
  /**
   * G7 — THE EDITOR'S OWN CARD. The editor samples its first 15 seconds of
   * main-thread lateness on mount (EditorScreen) and keeps the summary; this
   * grades it against the same band the take's card uses, so "no editor stall
   * > 30 ms" is one number a session can read instead of a claim.
   *
   *   await __inoutEditorReport()   the last editor open, graded
   */
  g.__inoutEditorReport = async () => {
    const { buildEditorCard } = await import('@core/report')
    const { lastEditorLateness, lastEditorLatenessTake } = await import('@core/lateness')
    return buildEditorCard(lastEditorLateness(), lastEditorLatenessTake())
  }
  /**
   * G7 — SAMPLE THIS THREAD FOR N MILLISECONDS, ANYWHERE, AND HAND BACK THE
   * SUMMARY. The take and the editor sample themselves; this is for the
   * questions neither of them answers — what a screen costs while it is being
   * dragged, and above all what the SAMPLER costs, which is measured by running
   * the same workload with and without one (scripts/g7-lateness.mjs --lanes=cost).
   *
   *   await __inoutLateness(5000)
   */
  g.__inoutLateness = async (ms?: unknown) => {
    const run = await (g.__inoutLatenessStart as () => Promise<{ stop: () => unknown }>)()
    await new Promise((res) => setTimeout(res, typeof ms === 'number' ? ms : 5_000))
    return run.stop()
  }
  /** The same sampler with the window left open — for a page-side script that
   *  has to start it, do something, and stop it. The cost A/B does exactly
   *  that, in one expression, so the handle never leaves the page. */
  g.__inoutLatenessStart = async () => (await import('@core/lateness')).startLateness()
}

// Offline start (task P2). PRODUCTION ONLY: a service worker in front of the
// dev server serves stale modules and makes every capture change a debugging
// puzzle. Registration is deferred to `load` so it can never compete with the
// first paint or with warming the capture pipeline.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then(async () => {
        /**
         * ASK THE WORKER TO CACHE THIS BUILD, WHOLE (task B3).
         *
         * The worker's install runs once ever — sw.js does not change between
         * deploys — so without this it would precache the first build a user
         * ever saw and no other. Every later build would again be caching only
         * the chunks it happened to fetch, and the lazy ones (export worker,
         * size probe, EditorScreen, session) would again 404 in any tab left
         * open across a deploy. Measured before this landed: seven assets gone,
         * the tab could not even reach the editor.
         *
         * Deliberately AFTER `load` and not awaited by anything: it competes
         * with nothing, and a failure costs only the guarantee it adds.
         */
        const reg = await navigator.serviceWorker.ready
        reg.active?.postMessage({ type: 'inout-precache-build' })
      })
      .catch((err) => {
        console.warn('[pwa] service worker registration failed', err)
      })
  })
  navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
    const d = ev.data as { type?: string; cached?: number; missed?: number; total?: number } | null
    if (d?.type !== 'inout-precache-done') return
    console.info(
      `[pwa] build precached: ${d.cached ?? 0} newly cached, ${d.missed ?? 0} unavailable, ${d.total ?? 0} in this build`,
    )
  })
}
