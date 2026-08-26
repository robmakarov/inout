/**
 * The CAPTURED-TAB half of the tabaudio rig (see tabAudioDeath.ts). A page
 * opened with `&tonechild=1` renames itself so Chrome's
 * --auto-select-tab-capture-source-by-title flag can pick it, then plays and
 * tears down audible tones on BroadcastChannel command — one "YouTube video"
 * per play, ended the way a player teardown looks to the audio stack. The
 * point of it being a SEPARATE TAB: a foreign tab has no capture of its own
 * keeping its audio stream alive, which is the topology PO actually records.
 */

export const TONE_CHILD_TITLE = 'TONECHILD'
export const TONE_CHANNEL = 'tabaudio-rig'

/** One "YouTube video": an audible tone element backed by its own graph. */
export function startVideo(freq: number): { stop: () => void } {
  const ctx = new AudioContext({ sampleRate: 48000 })
  const osc = new OscillatorNode(ctx, { frequency: freq })
  const gain = new GainNode(ctx, { gain: 0.4 })
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain)
  gain.connect(dest)
  osc.start()
  const el = document.createElement('audio')
  el.srcObject = dest.stream
  el.volume = 1
  void el.play().catch(() => undefined)
  document.body.appendChild(el)
  return {
    stop: () => {
      // The shape of a player teardown: element paused and released, tracks
      // stopped, context closed. After this the tab is genuinely silent.
      el.pause()
      el.srcObject = null
      el.remove()
      for (const t of dest.stream.getTracks()) t.stop()
      osc.stop()
      void ctx.close().catch(() => undefined)
    },
  }
}

/** Call at harness boot; returns true when this page is the captured child. */
export function initToneChildIfRequested(): boolean {
  if (typeof location === 'undefined' || !location.search.includes('tonechild=1')) return false
  document.title = TONE_CHILD_TITLE
  const bc = new BroadcastChannel(TONE_CHANNEL)
  let current: { stop: () => void } | null = null
  bc.onmessage = (e: MessageEvent) => {
    const m = e.data as { cmd?: string; freq?: number } | null
    if (m?.cmd === 'play') {
      current?.stop()
      current = startVideo(m.freq ?? 523)
      bc.postMessage({ evt: 'playing', freq: m.freq })
    } else if (m?.cmd === 'silence') {
      current?.stop()
      current = null
      bc.postMessage({ evt: 'silent' })
    } else if (m?.cmd === 'close') {
      current?.stop()
      window.close()
    }
  }
  // Announce repeatedly: the parent may attach its listener after our load.
  bc.postMessage({ evt: 'ready' })
  setInterval(() => bc.postMessage({ evt: 'ready' }), 1000)
  return true
}
