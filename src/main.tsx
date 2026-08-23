import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@app/App'
import { detectPlatform, evaluateSupport, probeMissingFeatures } from '@core/platform'
import './styles/base.css'

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
    void navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] service worker registration failed', err)
    })
  })
}
