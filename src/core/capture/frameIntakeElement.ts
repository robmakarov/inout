/**
 * THE ELEMENT SAMPLER — the frame-source seam's floor rung (task P9).
 *
 * For an engine with no MediaStreamTrackProcessor anywhere (Gecko today), the
 * only way a MediaStream's picture becomes a VideoFrame is to let a <video>
 * element decode it and then build a frame from the element. That is exactly
 * what v1 has always done, minus the drawImage: v1's mechanism, feeding v2's
 * worker.
 *
 * TWO THINGS ARE BORROWED FROM v1 BECAUSE THEY ARE PROVEN, NOT BECAUSE THEY
 * ARE CONVENIENT:
 *
 *  · THE CLOCK IS AN AudioWorklet, never rAF or setInterval. Recording means
 *    switching away, and a hidden document clamps both to ~1 Hz while an
 *    AudioWorklet keeps its render quantum. This is the same reason v1 ticks
 *    the way it does, and the same reason G7's beat lives off the main thread.
 *  · THE ELEMENTS ARE NEVER IN THE DOCUMENT. They decode anyway while playing,
 *    and an off-document element cannot be laid out, styled or scrolled into
 *    someone's way.
 *
 * WHAT IT COSTS, AND IT IS THE ONE RUNG THAT COSTS ANYTHING HERE: building a
 * VideoFrame from an element is a real copy on the main thread — the only rung
 * where the thread the UI runs on touches pixels. It is declared
 * (`mainThreadPixels`) rather than hidden, and it is bounded two ways: a frame
 * is built at most once per OUTPUT period, and never at all while the element's
 * own clock has not advanced. A static screen therefore delivers nothing here,
 * which is precisely what a track processor does with a static screen — the
 * rungs are alike in the thing that would otherwise differ silently.
 */

const TICKER_SOURCE = `
class InoutIntakeTick extends AudioWorkletProcessor {
  constructor() { super(); this.n = 0 }
  process() {
    this.n++
    // Every third render quantum: 128 frames each, 8 ms at 48 kHz, 125 Hz.
    // Comfortably above 60 fps so the sampler's own cadence, not the tick's,
    // decides when a frame is built.
    if (this.n >= 3) { this.port.postMessage(0); this.n = 0 }
    return true
  }
}
registerProcessor('inout-intake-tick', InoutIntakeTick)
`

let tickerUrl: string | null = null
function tickerModuleUrl(): string {
  tickerUrl ??= URL.createObjectURL(new Blob([TICKER_SOURCE], { type: 'application/javascript' }))
  return tickerUrl
}

function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement('video')
  v.srcObject = stream
  v.muted = true
  v.playsInline = true
  void v.play().catch(() => undefined)
  return v
}

type Kind = 'screen' | 'camera'

export interface ElementSamplerInit {
  screen?: MediaStream
  camera?: MediaStream
  /** The take's own AudioContext — the sampler adds a tick to it and nothing else. */
  audioContext: AudioContext
  /** The composite's output rate: at most one frame is built per period. */
  fps: number
  /**
   * A frame, ready to be transferred to the worker. The callee OWNS it and must
   * close or transfer it — the sampler never touches it again.
   *
   * `mediaSec` is the element's own clock at the moment it was read, which is
   * this rung's answer to a processor frame's `timestamp`: the liveness
   * detector's media clock, not the composite's timeline.
   */
  onFrame: (kind: Kind, frame: VideoFrame, atMs: number, mediaSec: number) => void
}

export interface ElementSamplerHandle {
  stop: () => void
  /** The element behind a source, for the geometry F13 reads. */
  element: (kind: Kind) => HTMLVideoElement | null
}

export function startElementSampler(init: ElementSamplerInit): Promise<ElementSamplerHandle> {
  const els = new Map<Kind, HTMLVideoElement>()
  if (init.screen) els.set('screen', videoFor(init.screen))
  if (init.camera) els.set('camera', videoFor(init.camera))

  const periodMs = 1000 / Math.max(1, init.fps) - 1
  const lastBuiltMs = new Map<Kind, number>()
  const lastMediaSec = new Map<Kind, number>()
  let stopped = false

  const Ctor = (globalThis as unknown as {
    VideoFrame: new (src: CanvasImageSource, init: { timestamp: number }) => VideoFrame
  }).VideoFrame

  const tick = (): void => {
    if (stopped) return
    const now = performance.now()
    for (const [kind, el] of els) {
      // HAVE_CURRENT_DATA: below this the element has no picture and the
      // constructor throws. A source still opening is not an error.
      if (el.readyState < 2 || el.videoWidth === 0) continue
      const mediaSec = el.currentTime
      if (mediaSec === lastMediaSec.get(kind)) continue
      const since = now - (lastBuiltMs.get(kind) ?? -Infinity)
      if (since < periodMs) continue
      let frame: VideoFrame
      try {
        // The element's own clock, in microseconds — the closest thing this
        // rung has to a capture stamp, and what the liveness detector reads.
        frame = new Ctor(el, { timestamp: Math.round(mediaSec * 1e6) })
      } catch {
        // A frame that cannot be built is not a take that ends: the next tick
        // is 8 ms away and the liveness detector is already watching this
        // source's clock.
        continue
      }
      lastMediaSec.set(kind, mediaSec)
      lastBuiltMs.set(kind, now)
      init.onFrame(kind, frame, now, mediaSec)
    }
  }

  return (async (): Promise<ElementSamplerHandle> => {
    await init.audioContext.audioWorklet.addModule(tickerModuleUrl())
    const ticker = new AudioWorkletNode(init.audioContext, 'inout-intake-tick', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // Connected for the same reason v1 connects its ticker: an AudioWorkletNode
    // whose output reaches nothing is not guaranteed to be pulled. It emits
    // nothing, so the mix is unchanged.
    ticker.connect(init.audioContext.destination)
    ticker.port.onmessage = tick
    return {
      element: (kind) => els.get(kind) ?? null,
      stop: () => {
        if (stopped) return
        stopped = true
        ticker.port.onmessage = null
        try {
          ticker.disconnect()
        } catch {
          /* already gone */
        }
        for (const el of els.values()) {
          el.pause()
          el.srcObject = null
        }
        els.clear()
      },
    }
  })()
}
