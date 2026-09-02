/**
 * U1 — CAN THE RECORDER PANEL OPEN ON THE RECORD PRESS?
 *
 * `documentPictureInPicture.requestWindow()` needs transient user activation.
 * So does `getDisplayMedia`, and this app fires that one FIRST, synchronously
 * inside the click, because WebKit drops activation on any prior await
 * (acquire.ts:1133). If the screen request CONSUMES the activation, the panel
 * can never open from the same press and U1 needs a different door.
 *
 * Nothing here is argued from the spec: every answer is read off real Chrome,
 * from a real CDP-dispatched click, on the deployed build.
 *
 *   node scripts/dpip-check.mjs [--url=https://inout-kappa.vercel.app]
 *
 * Cases, each from its own fresh click:
 *   plain          requestWindow() straight out of the gesture      (the floor)
 *   microtask      one resolved-await first                (what loadCaptureEngine costs)
 *   afterDisplay   getDisplayMedia() fired first, not awaited        (the real order)
 *   noActivation   from a timer, no gesture at all                   (the control)
 *
 * The screen picker is kept out of it with --auto-select-desktop-capture-source;
 * if the flag misses, the request simply never settles — this rig never awaits
 * it, so the reading is the same either way, and the throwaway profile is killed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const URL_ = arg('url', 'https://inout-kappa.vercel.app/')
const CASES = arg('cases', 'plain,microtask,afterDisplay,noActivation').split(',')
/** Cases that must NOT get the auto-select flag: the point is a real picker. */
const NEEDS_PICKER = CASES.includes('pickerAlive')

const PROBE = `(() => {
  const b = document.createElement('button')
  b.id = '__dpipprobe'
  b.textContent = 'probe'
  b.style.cssText = 'position:fixed;left:8px;top:8px;width:120px;height:40px;z-index:2147483647'
  b.addEventListener('click', async () => {
    const c = window.__dpipCase
    const out = { case: c, activationAtClick: navigator.userActivation?.isActive ?? null }
    try {
      if (c === 'microtask') await Promise.resolve()
      if (c === 'panelFirst') {
        // DOES requestWindow CONSUME THE ACTIVATION? Read synchronously across
        // the CALL, before any await — consumption is a renderer-side,
        // synchronous act, so this is the only reading that cannot be confused
        // by what the browser process does later. No picker is involved.
        const before = navigator.userActivation?.isActive ?? null
        const pw = documentPictureInPicture.requestWindow({ width: 280, height: 116 })
        out.activationBeforeCall = before
        out.activationAfterCall = navigator.userActivation?.isActive ?? null
        const w0 = await pw
        out.opened = true
        w0.close()
        window.__dpip = out
        return
      }
      if (c === 'pickerAlive') {
        // THE ONE THAT COULD BREAK A WORKING PATH: the panel window opens while
        // Chrome's screen picker is on screen. If the picker survives, the
        // display promise is still PENDING three seconds later; if the panel
        // stole its focus and dismissed it, the promise has already rejected.
        let settled = null
        const p = navigator.mediaDevices.getDisplayMedia({ video: true })
        p.then((s2) => { settled = 'resolved'; for (const t of s2.getTracks()) t.stop() },
               (e) => { settled = e.name + ': ' + e.message })
        out.activationBeforeRequest = navigator.userActivation?.isActive ?? null
        const w1 = await documentPictureInPicture.requestWindow({ width: 280, height: 116 })
        out.opened = true
        await new Promise((r) => setTimeout(r, 3000))
        out.pickerAfter3s = settled === null ? 'still open' : settled
        w1.close()
        window.__dpip = out
        return
      }
      if (c === 'afterDisplay') {
        out.displayFired = true
        // Deliberately NOT awaited: the app does the same (acquire.ts fires it
        // and awaits later), and awaiting a picker would end the gesture.
        navigator.mediaDevices.getDisplayMedia({ video: true }).then(
          (s) => { out.displayGot = true; for (const t of s.getTracks()) t.stop() },
          (e) => { out.displayError = e.name + ': ' + e.message },
        )
      }
      out.activationBeforeRequest = navigator.userActivation?.isActive ?? null
      const t0 = performance.now()
      const w = await documentPictureInPicture.requestWindow({ width: 280, height: 116 })
      out.openMs = Math.round(performance.now() - t0)
      out.opened = true
      const style = w.document.createElement('style')
      style.textContent = 'html,body{margin:0;height:100%;background:#0b0b0d;color:#e6e4df;font:12px system-ui}'
      w.document.head.appendChild(style)
      w.document.body.textContent = 'U1 probe'
      out.inner = [w.innerWidth, w.innerHeight]
      out.outer = [w.outerWidth, w.outerHeight]
      out.titleBarPx = w.outerHeight - w.innerHeight
      out.sidePx = w.outerWidth - w.innerWidth
      // Does the panel document see the app's origin as its own? (portals need it)
      out.sameOrigin = (() => { try { return w.document.URL === document.URL || w.document.URL === 'about:blank' } catch { return false } })()
      out.hasResizeTo = (() => {
        const h0 = w.outerHeight
        try { w.resizeTo(w.outerWidth, h0 + 40) } catch { return 'threw' }
        return w.outerHeight !== h0 ? 'moved' : 'ignored'
      })()
      await new Promise((r) => setTimeout(r, 400))
      w.close()
    } catch (e) {
      out.opened = false
      out.error = e.name + ': ' + e.message
    }
    window.__dpip = out
  })
  document.body.appendChild(b)
  return {
    api: 'documentPictureInPicture' in window,
    secure: isSecureContext,
    ua: navigator.userAgent,
  }
})()`

const bin = resolveChrome()
if (!bin) {
  console.error('dpip-check: no Chrome found (set CHROME_BIN)')
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'inout-dpip-'))
let s
try {
  s = await launchChromeRetrying({
    bin,
    profile,
    url: URL_,
    headed: true,
    extraArgs: NEEDS_PICKER ? [] : ['--auto-select-desktop-capture-source=Entire screen'],
  })
  await sleep(2500)
  const env = await s.evalJson(PROBE)
  console.log(`chrome: ${env?.ua ?? '?'}`)
  console.log(`documentPictureInPicture present: ${env?.api} · secureContext: ${env?.secure}`)
  if (!env?.api) {
    console.log('VERDICT: the API is absent here — U1 falls back to nothing.')
  } else {
    const rows = []
    for (const c of CASES) {
      await s.evaluate(`(window.__dpip = null, window.__dpipCase = ${JSON.stringify(c)})`)
      if (c === 'noActivation') {
        await s.evaluate(`document.getElementById('__dpipprobe').click()`)
      } else {
        // A real click: CDP input is what gives the page transient activation.
        for (const type of ['mousePressed', 'mouseReleased']) {
          await s.send('Input.dispatchMouseEvent', {
            type, x: 68, y: 28, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0,
          })
        }
      }
      let r = null
      for (let i = 0; i < 80 && !r; i++) {
        r = await s.evalJson('window.__dpip')
        if (!r) await sleep(250)
      }
      rows.push(r ?? { case: c, error: 'no result in 15 s' })
      console.log(`\n[${c}] ${JSON.stringify(r, null, 2)}`)
      await sleep(600)
    }
    const byCase = Object.fromEntries(rows.map((r) => [r.case, r]))
    console.log('\n--- VERDICT -------------------------------------------------')
    const d = byCase.afterDisplay
    if (d) {
      console.log(
        `getDisplayMedia consumes the activation: ${d.activationBeforeRequest === false ? 'YES' : 'NO'} ` +
          `(isActive after the call = ${d.activationBeforeRequest})`,
      )
      console.log(`panel opens in the same task as the screen request: ${d.opened ? 'YES' : `NO — ${d.error}`}`)
    }
    if (byCase.plain?.opened) {
      console.log(
        `geometry: asked 280x116 → inner ${byCase.plain.inner.join('x')}, outer ${byCase.plain.outer.join('x')}, ` +
          `title bar ${byCase.plain.titleBarPx}px, sides ${byCase.plain.sidePx}px, resizeTo ${byCase.plain.hasResizeTo}`,
      )
    }
    if (byCase.microtask) console.log(`survives one resolved await: ${byCase.microtask.opened ? 'YES' : `NO — ${byCase.microtask.error}`}`)
    if (byCase.pickerAlive)
      console.log(
        `the screen picker survives the panel opening over it: ` +
          (byCase.pickerAlive.pickerAfter3s === 'still open'
            ? 'YES (still open after 3 s)'
            : `NO — it settled as ${byCase.pickerAlive.pickerAfter3s}`),
      )
    if (byCase.panelFirst)
      console.log(
        `requestWindow consumes the activation: ${byCase.panelFirst.activationAfterPanel === false ? 'YES' : 'NO'} ` +
          `→ getDisplayMedia after a panel: ${byCase.panelFirst.displayAfterPanel}`,
      )
    if (byCase.noActivation) console.log(`opens with no gesture at all: ${byCase.noActivation.opened ? 'YES' : `NO — ${byCase.noActivation.error}`}`)
  }
} finally {
  await quitChrome(s)
  rmSync(profile, { recursive: true, force: true })
}
