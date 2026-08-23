import type { CaptureConfig, ChannelKind } from '@core/types'
import type { AcquiredChannel, ProgressiveAcquire, ProgressiveHandlers } from './acquire'
import { primaryKindFor } from './acquire'

export function isSyntheticMode(): boolean {
  return typeof location !== 'undefined' && location.search.includes('synthetic')
}

/**
 * Test harness knob: ?synthetic=1&slow=camera:3000,mic:8000 delays channel
 * delivery, simulating cold devices — the acceptance rig for instant-arm.
 * A delay beyond ACQUIRE_TIMEOUT_MS effectively simulates a dead device.
 */
export function parseSlowChannels(search: string): Map<ChannelKind, number> {
  const out = new Map<ChannelKind, number>()
  const raw = new URLSearchParams(search).get('slow')
  if (!raw) return out
  for (const part of raw.split(',')) {
    const [kind, ms] = part.split(':')
    const delay = Number(ms)
    if (
      (kind === 'screen' || kind === 'camera' || kind === 'mic' || kind === 'system-audio') &&
      Number.isFinite(delay) &&
      delay > 0
    ) {
      out.set(kind, delay)
    }
  }
  return out
}

export interface SyntheticRig {
  channels: AcquiredChannel[]
  dispose: () => void
}

interface Generated {
  stream: MediaStream
  stop: () => void
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d canvas context unavailable')
  return g
}

const DEFAULT_SCREEN = { width: 1280, height: 720 }
let screenSize = DEFAULT_SCREEN

/**
 * Harness knob, same family as `slow=` and `quiet=`: how big the synthetic
 * screen is. The load rigs (P0-tail, P0-tail-raw) need a source large enough to
 * genuinely starve an encoder — a 4K surface is PO's own failing scenario — and
 * the harness page is loaded once per experiment, so this has to be settable
 * from the runner rather than from the URL. Production never calls it.
 */
export function setSyntheticScreenSize(size: { width: number; height: number } | null): void {
  screenSize = size ?? DEFAULT_SCREEN
}

function syntheticScreen(): Generated {
  const { width: W, height: H } = screenSize
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = get2d(canvas)
  const startedAt = performance.now()
  const s = W / 1280
  let frame = 0
  let raf = 0
  const draw = (): void => {
    const t = (performance.now() - startedAt) / 1000
    const hue = (t * 6) % 360
    const grad = g.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, `hsl(${hue}, 45%, 10%)`)
    grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 22%)`)
    g.fillStyle = grad
    g.fillRect(0, 0, W, H)
    frame += 1
    g.fillStyle = '#ffffff'
    g.textAlign = 'center'
    g.font = `bold ${Math.round(120 * s)}px monospace`
    g.fillText(String(frame), W / 2, H * (320 / 720))
    g.font = `${Math.round(48 * s)}px monospace`
    g.fillText(`${t.toFixed(1)}s`, W / 2, H * (410 / 720))
    const x = ((t * 240 * s) % (W + 160 * s)) - 160 * s
    g.fillStyle = `hsl(${(hue + 180) % 360}, 80%, 60%)`
    g.fillRect(x, H * (560 / 720), 160 * s, 40 * s)
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { stream: canvas.captureStream(30), stop: () => cancelAnimationFrame(raf) }
}

function syntheticCamera(): Generated {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 480
  const g = get2d(canvas)
  const r = 48
  let x = 320
  let y = 240
  let vx = 4.2
  let vy = 3.1
  let raf = 0
  const draw = (): void => {
    g.fillStyle = '#7f7f7f'
    g.fillRect(0, 0, 640, 480)
    x += vx
    y += vy
    if (x < r || x > 640 - r) {
      vx = -vx
      x = Math.max(r, Math.min(640 - r, x))
    }
    if (y < r || y > 480 - r) {
      vy = -vy
      y = Math.max(r, Math.min(480 - r, y))
    }
    g.fillStyle = '#e2554f'
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { stream: canvas.captureStream(30), stop: () => cancelAnimationFrame(raf) }
}

/** Harness knob: `&quiet=0.05` scales synthetic audio down to e2e-test the
 * loudness normalization (reproduces a faint real-world mic capture). */
export function parseQuietScale(search: string): number {
  const raw = Number(new URLSearchParams(search).get('quiet'))
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1
}

function quietScale(): number {
  return typeof location !== 'undefined' ? parseQuietScale(location.search) : 1
}

function syntheticMic(ctx: AudioContext): Generated {
  const q = quietScale()
  const osc = new OscillatorNode(ctx, { frequency: 440 })
  // gain pulses 0..0.5 at ~2Hz: base 0.25 + 0.25 LFO
  const gain = new GainNode(ctx, { gain: 0.25 * q })
  const lfo = new OscillatorNode(ctx, { frequency: 2 })
  const lfoGain = new GainNode(ctx, { gain: 0.25 * q })
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest)
  lfo.connect(lfoGain).connect(gain.gain)
  osc.start()
  lfo.start()
  const stop = (): void => {
    try {
      osc.stop()
      lfo.stop()
    } catch {
      /* already stopped */
    }
  }
  return { stream: dest.stream, stop }
}

function syntheticSystemAudio(ctx: AudioContext): Generated {
  const osc = new OscillatorNode(ctx, { frequency: 220 })
  const gain = new GainNode(ctx, { gain: 0.2 * quietScale() })
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain).connect(dest)
  osc.start()
  const stop = (): void => {
    try {
      osc.stop()
    } catch {
      /* already stopped */
    }
  }
  return { stream: dest.stream, stop }
}

export function createSyntheticChannels(config: CaptureConfig): SyntheticRig {
  const channels: AcquiredChannel[] = []
  const teardowns: (() => void)[] = []
  const audioCtx = config.mic || config.systemAudio ? new AudioContext() : null

  const add = (kind: AcquiredChannel['kind'], media: AcquiredChannel['media'], gen: Generated): void => {
    channels.push({ kind, media, stream: gen.stream, track: gen.stream.getTracks()[0] })
    teardowns.push(gen.stop)
  }

  if (config.screen) add('screen', 'video', syntheticScreen())
  if (config.camera) add('camera', 'video', syntheticCamera())
  if (audioCtx) {
    if (config.mic) add('mic', 'audio', syntheticMic(audioCtx))
    if (config.systemAudio) add('system-audio', 'audio', syntheticSystemAudio(audioCtx))
    void audioCtx.resume().catch(() => undefined)
  }

  const dispose = (): void => {
    for (const t of teardowns) {
      try {
        t()
      } catch {
        /* best-effort teardown */
      }
    }
    teardowns.length = 0
    for (const c of channels) for (const t of c.stream.getTracks()) t.stop()
    if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close().catch(() => undefined)
  }

  return { channels, dispose }
}

export interface SyntheticProgressiveRig extends ProgressiveAcquire {
  dispose: () => void
}

/** Progressive synthetic source — mirrors acquireChannelsProgressive semantics,
 * with per-channel delivery delays from the `slow=` URL param. */
export function createSyntheticChannelsProgressive(
  config: CaptureConfig,
  handlers: ProgressiveHandlers,
): SyntheticProgressiveRig {
  const rig = createSyntheticChannels(config)
  const delays =
    typeof location !== 'undefined' ? parseSlowChannels(location.search) : new Map<ChannelKind, number>()
  const primary = primaryKindFor(config)
  let primaryResolve!: () => void
  const primaryReady = new Promise<void>((r) => {
    primaryResolve = r
  })
  let disposed = false
  const timers: ReturnType<typeof setTimeout>[] = []

  const deliveries = rig.channels.map(
    (ch) =>
      new Promise<void>((resolve) => {
        const emit = (): void => {
          if (!disposed) {
            handlers.onChannel(ch)
            if (ch.kind === primary) primaryResolve()
          }
          resolve()
        }
        const delay = delays.get(ch.kind) ?? 0
        if (delay > 0) timers.push(setTimeout(emit, delay))
        else queueMicrotask(emit)
      }),
  )

  const settled = Promise.all(deliveries).then(() => undefined)
  void settled.then(() => primaryResolve())

  return {
    primaryReady,
    settled,
    dispose: (): void => {
      disposed = true
      for (const t of timers) clearTimeout(t)
      rig.dispose()
    },
  }
}
