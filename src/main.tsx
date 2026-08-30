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
