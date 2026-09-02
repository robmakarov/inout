import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatTimer } from '@app/lib/format'

/**
 * U1 — WHAT THE ON-TOP PANEL SHOWS. The window itself is app/lib/recorderPanel.ts;
 * this is its contents, rendered through a portal into that window's document.
 *
 * EVERY CLOCK IN HERE IS THE PANEL WINDOW'S, NOT THE PAGE'S. While a take runs
 * the app tab is hidden behind whatever is being recorded, so its timers are
 * clamped to ~1 Hz and its `requestAnimationFrame` does not run at all. The
 * panel window is never hidden — it is the one surface still being painted —
 * so the timer interpolates on `win.setInterval` and the ring is driven by
 * `win.requestAnimationFrame`. Using the page's would freeze both exactly when
 * they are the only thing the user can see.
 *
 * The buttons make the SAME calls the page's own controls make — no second
 * path to stop, pause or cancel a take (U1's gate).
 */

export type PanelMode = 'arming' | 'recording' | 'paused' | 'finishing'

/** Level ring, one analyser, painted on the panel window's frames. */
function PanelRing({ win, stream }: { win: Window; stream: MediaStream }) {
  const ringRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (stream.getAudioTracks().length === 0) return
    let raf = 0
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      // Half the app's fftSize: this ring is 22 px across and lives beside a
      // running take, so it buys its liveness with as little work as it can.
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = (): void => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 4)
        const el = ringRef.current
        if (el) {
          el.style.transform = `scale(${1 + level * 0.6})`
          el.style.opacity = `${0.35 + level * 0.65}`
        }
        raf = win.requestAnimationFrame(tick)
      }
      raf = win.requestAnimationFrame(tick)
    } catch {
      return
    }
    return () => {
      win.cancelAnimationFrame(raf)
      void ctx?.close().catch(() => {})
    }
  }, [win, stream])

  return (
    <div className="rp__ring" aria-hidden="true">
      <i ref={ringRef} />
      <b />
    </div>
  )
}

export function RecorderPanel({
  win,
  mode,
  elapsedMs,
  remainingMs,
  audioStream,
  onStop,
  onTogglePause,
}: {
  win: Window
  mode: PanelMode
  elapsedMs: number
  /** null = uncapped take, so there is no last minute to warn about. */
  remainingMs: number | null
  audioStream?: MediaStream
  /** Stop the take — or cancel the arm, exactly as the record button does. */
  onStop: () => void
  /** F6 pause / resume. Absent = the engine cannot be held right now. */
  onTogglePause?: () => void
}) {
  /**
   * The engine's tick arrives on the PAGE's timer, which the browser clamps
   * while the tab is hidden. Interpolating between ticks on the panel's own
   * clock is what keeps the seconds moving in front of the user; the tick is
   * still the truth, and a pause simply stops the interpolation (the take's
   * elapsed time does not count the hold — session.ts moves the epoch).
   */
  const anchor = useRef({ ms: elapsedMs, at: performance.now() })
  if (anchor.current.ms !== elapsedMs) anchor.current = { ms: elapsedMs, at: performance.now() }
  const [, tick] = useState(0)
  useEffect(() => {
    const id = win.setInterval(() => tick((n) => n + 1), 250)
    return () => win.clearInterval(id)
  }, [win])

  const running = mode === 'recording'
  const shown = running
    ? Math.max(elapsedMs, anchor.current.ms + (performance.now() - anchor.current.at))
    : elapsedMs
  const warn = remainingMs !== null && remainingMs < 60_000
  const live = mode === 'recording' || mode === 'paused'

  const body = (
    <div
      className={
        'rp' +
        (mode === 'paused' ? ' rp--paused' : '') +
        (live ? '' : ' rp--idle') +
        (warn ? ' rp--warn' : '')
      }
    >
      <div className="rp__head">
        <span className="rp__dot" />
        {live ? (
          <span className="rp__time">{formatTimer(shown)}</span>
        ) : (
          <span className="rp__label">{mode === 'arming' ? 'Starting…' : 'Saving…'}</span>
        )}
        {live && mode === 'paused' && <span className="rp__label">Paused</span>}
        {live && audioStream && <PanelRing win={win} stream={audioStream} />}
      </div>
      <div className="rp__actions">
        <button
          type="button"
          className="rp__btn rp__btn--stop"
          onClick={onStop}
          disabled={mode === 'finishing'}
        >
          {mode === 'arming' ? 'Cancel' : 'Stop'}
        </button>
        {live && onTogglePause && (
          <button type="button" className="rp__btn" onClick={onTogglePause}>
            {mode === 'paused' ? 'Continue' : 'Pause'}
          </button>
        )}
      </div>
    </div>
  )

  return createPortal(body, win.document.body)
}
