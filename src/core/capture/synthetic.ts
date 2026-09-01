import type { CaptureConfig, ChannelKind } from '@core/types'
import type {
  AcquiredChannel,
  ArmingStep,
  ProgressiveAcquire,
  ProgressiveHandlers,
} from './acquire'
import { capDisplayTrack, primaryKindFor } from './acquire'

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

/**
 * H4 HARNESS KNOB, `?dead=camera` — A CHANNEL THAT RECORDS NOTHING, WITH
 * NOTHING WRONG WITH ITS TRACK.
 *
 * B4's evidence, four times on a real device: a camera whose track is live,
 * unmuted and negotiated at 1920x1080@30 while the sensor is off (a closed lid
 * does exactly this) records for the take's full length, delivers ZERO frames,
 * and writes a 28-byte file. Nothing in the product is wrong-looking from the
 * inside — `readyState` is 'live', `muted` is false, `getSettings()` reads
 * 1920x1080@30 — which is precisely why the liveness detector, whose
 * disambiguator IS `muted`, could never call it. Until now it could only be
 * reproduced by closing a laptop lid mid-run, so it was never reproduced.
 *
 * Video kinds only: an audio source that delivers no samples is a different
 * failure (silence, which measuredAudio already counts) and this is the
 * zero-FRAME one.
 */
export function parseDeadChannels(search: string): Set<ChannelKind> {
  const out = new Set<ChannelKind>()
  const raw = new URLSearchParams(search).get('dead')
  if (!raw) return out
  for (const part of raw.split(',')) {
    const kind = part.trim()
    if (kind === 'screen' || kind === 'camera') out.add(kind)
  }
  return out
}

/**
 * H4 HARNESS KNOB, `?die=camera:20000` — A DEVICE THAT DIES MID-TAKE.
 *
 * The BT mic that drops at minute 40, the camera someone unplugs, the shared
 * window whose owner quits. All of them reach the page the same way: the track
 * fires `ended` while the take runs on. Milliseconds are measured from the
 * RECORD PRESS, not from the arm — the death has to land inside the take or it
 * is testing arming instead.
 *
 * Note `track.stop()` deliberately does NOT fire `ended` (that event is
 * reserved for an end the page did not ask for), so the rig stops the track
 * AND dispatches the event, which is what a real unplug does.
 */
export function parseDyingChannels(search: string): Map<ChannelKind, number> {
  const out = new Map<ChannelKind, number>()
  const raw = new URLSearchParams(search).get('die')
  if (!raw) return out
  for (const part of raw.split(',')) {
    const [kind, ms] = part.split(':')
    const at = Number(ms)
    if (
      (kind === 'screen' || kind === 'camera' || kind === 'mic' || kind === 'system-audio') &&
      Number.isFinite(at) &&
      at >= 0
    ) {
      out.set(kind, at)
    }
  }
  return out
}

/**
 * Schedule the `?die=` deaths. Called by the session at the record press so the
 * clock is the take's, and a no-op with no knob and outside synthetic mode.
 * Returns the canceller, so a take that stops first kills its own timers.
 */
export function armSyntheticDeaths(
  channels: readonly { kind: ChannelKind; track: MediaStreamTrack }[],
): () => void {
  if (typeof location === 'undefined') return () => undefined
  const dying = parseDyingChannels(location.search)
  if (dying.size === 0) return () => undefined
  const timers: ReturnType<typeof setTimeout>[] = []
  for (const ch of channels) {
    const at = dying.get(ch.kind)
    if (at === undefined) continue
    timers.push(
      setTimeout(() => {
        console.warn(`[capture:harness] killing the ${ch.kind} track at +${at}ms (?die=)`)
        try {
          ch.track.stop()
        } catch {
          /* already stopped */
        }
        ch.track.dispatchEvent(new Event('ended'))
      }, at),
    )
  }
  return () => {
    for (const t of timers) clearTimeout(t)
  }
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

/**
 * THE ONE PAINTER EVERY SYNTHETIC SOURCE USES (task G2).
 *
 * A synthetic source is a canvas handed to `captureStream()`, and such a track
 * emits a frame only when the canvas is PAINTED. Painting from
 * requestAnimationFrame is the obvious way and it is not sufficient here: rAF
 * is the COMPOSITOR's clock, so under exactly the load these rigs exist to
 * create — a 4K surface being captured, downscaled and fed to two or three
 * hardware encoders — it degrades with everything else. Measured on the 4K
 * load rig: the same take painted from rAF delivered 16.5 fps into the raw
 * encoder on its first run and 9.8 on its second, and the fps band charged
 * that to the PRODUCT.
 *
 * The roadmap's version of this ("a headless page runs rAF at 0") is refuted —
 * `npm run exp -- rigsource` reads rAF at 120 Hz headless AND headed. rAF is
 * not dead; it is merely not independent of the thing under test.
 *
 * So rAF stays the primary, because a headed run should keep painting on the
 * display's own clock, and an interval watchdog sits behind it and paints only
 * when rAF has been quiet for longer than a frame period. On an idle visible
 * window the watchdog never fires and the lane is what it always was.
 *
 * Harness-only: nothing outside `?synthetic=1` reaches it.
 */
export interface PaintLoop {
  stop: () => void
  /** Paints the watchdog had to make because rAF had gone quiet. */
  watchdogPaints: () => number
  /** Total paints, whoever made them. */
  paints: () => number
}

export function paintLoop(draw: () => void, fps = 30): PaintLoop {
  const periodMs = 1000 / Math.max(1, fps)
  let raf = 0
  let running = true
  let paints = 0
  let watchdogPaints = 0
  // The last time rAF ITSELF painted — NOT the last paint of any kind. Gating
  // on "any paint" makes the watchdog throttle itself: it paints, sees its own
  // fresh paint one period later, skips, and delivers half the rate asked for
  // (measured: 15 of 30). The question the watchdog has to answer is whether
  // rAF is still carrying the lane, and only rAF's own clock answers it.
  let lastRafAt = performance.now()

  const paint = (): void => {
    paints++
    draw()
  }
  const tick = (): void => {
    if (!running) return
    lastRafAt = performance.now()
    paint()
    raf = requestAnimationFrame(tick)
  }
  // Painted once before anything attaches: a captureStream whose canvas has
  // never been painted delivers nothing at all, which is a different failure
  // wearing the same symptom.
  paint()
  raf = requestAnimationFrame(tick)

  // 1.5 periods of slack, so a display running at exactly `fps` never trips it
  // and a headed run stays the control rather than paying double paints.
  const timer = setInterval(
    () => {
      if (!running) return
      if (performance.now() - lastRafAt < periodMs * 1.5) return
      watchdogPaints++
      paint()
    },
    Math.max(4, Math.round(periodMs)),
  )

  return {
    stop: () => {
      running = false
      cancelAnimationFrame(raf)
      clearInterval(timer)
    },
    watchdogPaints: () => watchdogPaints,
    paints: () => paints,
  }
}

let lastScreenLoop: PaintLoop | null = null
let lastCameraLoop: PaintLoop | null = null

/**
 * WHAT PAINTED THE SOURCE — the readout a load rig has to quote (task G2).
 *
 * A band measured on a synthetic source is only about the product if the source
 * kept up. `paints` says whether it did; `watchdogPaints` says whether rAF was
 * still the clock or the watchdog was carrying it, which is the difference
 * between "this machine is loaded" and "this rig is measuring itself".
 * Harness-only; production never calls it.
 */
export function syntheticPaintStats(): {
  screen: { paints: number; watchdogPaints: number } | null
  camera: { paints: number; watchdogPaints: number } | null
} {
  const read = (l: PaintLoop | null): { paints: number; watchdogPaints: number } | null =>
    l ? { paints: l.paints(), watchdogPaints: l.watchdogPaints() } : null
  return { screen: read(lastScreenLoop), camera: read(lastCameraLoop) }
}

/** Forget the previous take's painters so a per-run readout is per-run. */
export function resetSyntheticPaintStats(): void {
  lastScreenLoop = null
  lastCameraLoop = null
}

const DEFAULT_SCREEN = { width: 1280, height: 720 }
let screenSize = DEFAULT_SCREEN

/**
 * The rate the synthetic sources hand over — the product's own floor unless a
 * knob says otherwise (F15). Both generators paint from requestAnimationFrame,
 * so 60 is the most a display can actually deliver here and asking for more
 * would produce a track that lies.
 */
const DEFAULT_SYNTHETIC_FPS = 30
let screenFps = DEFAULT_SYNTHETIC_FPS
let cameraFps = DEFAULT_SYNTHETIC_FPS

/**
 * Harness knob, same family as `slow=` and `quiet=`: how big the synthetic
 * screen is. The load rigs (P0-tail, P0-tail-raw) need a source large enough to
 * genuinely starve an encoder — a 4K surface is Robert's own failing scenario — and
 * the harness page is loaded once per experiment, so this has to be settable
 * from the runner rather than from the URL. Production never calls it.
 */
export function setSyntheticScreenSize(size: { width: number; height: number } | null): void {
  screenSize = size ?? DEFAULT_SCREEN
}

export type SyntheticScreenContent = 'default' | 'text'
let screenContent: SyntheticScreenContent = 'default'

/**
 * Harness knob, the same family as `setSyntheticScreenSize`: WHAT the synthetic
 * screen paints. Production never calls it; the default is unchanged.
 *
 * The default source is a full-frame gradient with a big frame counter and a
 * sliding bar — the right fixture for sync and throughput, and the wrong one
 * for anything about TEXT: two enormous glyphs on a smooth ground, where a
 * chroma-upsampling difference has almost nothing to land on. X15(c) has to ask
 * whether adding a trim changes how a take's text looks, so it needs a screen
 * that is mostly small coloured glyphs — the same code-editor page the bits
 * audit and the O9 text rig are measured on, so the numbers are comparable.
 *
 * AND IT HOLDS PERFECTLY STILL, which is the part that was learned the hard
 * way. The bits-audit page scrolls a line every 2.5 s, and two export paths do
 * not place their first frame at the same instant — so comparing them on a
 * scrolling page measures WHERE each file starts, not what either painter drew.
 * Measured: instant and render read 13.1 dB, and the dumped frames showed the
 * same page one line apart. A still page cannot express that confound, so what
 * is left in a comparison is the pixels, which is the whole question. The
 * camera PiP still moves and is where placement gets measured instead.
 */
export function setSyntheticScreenContent(content: SyntheticScreenContent | null): void {
  screenContent = content ?? 'default'
}

/**
 * THE EDITOR PAGE'S PALETTE, IN ONE PLACE — and it is one place because it was
 * five (R1 fix 10).
 *
 * The same three glyph colours were pasted into synthetic.ts, textSource.ts
 * twice, bitsAudit.ts and aiExport.ts, and the chroma rig's copy was the only
 * one written as decimal RGB. That is not a tidiness point: `chromaRows()`
 * masks the reference BY THIS PALETTE, so one digit of drift between the
 * painter and the mask empties the mask — and an empty mask used to read as
 * "0 % of the colour kept", i.e. a fabricated P1, while the gate that compares
 * two exports passed vacuously because both were measuring nothing. Every
 * painter and every mask now derives from here.
 *
 * `glyph` is ordered the way `glyphColour()` assigns it, and the names are the
 * ones the chroma tables in TASKS/BACKLOG/CONTEXT use.
 */
export const TEXT_SCREEN_PALETTE = {
  background: '#0d1117',
  gutter: '#484f58',
  caret: '#c9d1d9',
  glyph: [
    { key: 'grey', hex: '#c9d1d9' },
    { key: 'green', hex: '#7ee787' },
    { key: 'blue', hex: '#79c0ff' },
  ],
} as const

export type GlyphColourKey = (typeof TEXT_SCREEN_PALETTE.glyph)[number]['key']

/** Which glyph colour line `i` is painted in — the one rule, not four copies. */
export function glyphColour(i: number): string {
  const [grey, green, blue] = TEXT_SCREEN_PALETTE.glyph
  return i % 5 === 0 ? green.hex : i % 3 === 0 ? blue.hex : grey.hex
}

/**
 * The bits-audit editor page, held still — see setSyntheticScreenContent.
 *
 * EXPORTED so a rig can reconstruct the exact picture the synthetic screen put
 * on the wire. Without that there is no reference for anything a real take
 * produces: the take's frames are only ever available AFTER an encoder, so
 * every measurement would be file-against-file and a loss shared by all files
 * would cancel out and read as zero. That is precisely how the chroma loss Robert
 * spotted by eye escaped X15(c)'s first pass. Deterministic, so the reference
 * is free — same size in, same pixels out, forever.
 */
export function drawTextScreen(g: CanvasRenderingContext2D, W: number, H: number): void {
  const words = ['const', 'function', 'return', 'await', 'export', 'if', 'for', 'type']
  g.fillStyle = TEXT_SCREEN_PALETTE.background
  g.fillRect(0, 0, W, H)
  g.textAlign = 'left'
  g.font = `${Math.round(H / 38)}px monospace`
  g.textBaseline = 'top'
  for (let row = 0; row < 34; row++) {
    const i = row % 60
    const indent = '  '.repeat(i % 4)
    const text = `${indent}${words[i % words.length]} sample${i} = compute(${i}, 'channel-${i % 7}')`
    g.fillStyle = TEXT_SCREEN_PALETTE.gutter
    g.fillText(String(row + 1).padStart(3, ' '), W * 0.01, row * (H / 36) + 8)
    g.fillStyle = glyphColour(i)
    g.fillText(text, W * 0.05, row * (H / 36) + 8)
  }
}

/**
 * The reference picture, rasterized THROUGH THE CONTEXT THE WIRE ACTUALLY USES
 * (R1 fix 3).
 *
 * The chroma rig built its reference on a `{alpha:false}` canvas while
 * `syntheticScreen()` paints on `get2d()`'s default — an alpha:true one. An
 * opaque canvas is eligible for different text antialiasing, so the reference
 * and the picture on the wire could disagree about every glyph edge before a
 * single frame was encoded, and the rig's own 0-source self-row is
 * structurally blind to it (it compares the reference with itself). Going
 * through `get2d` means the two cannot drift: there is one context factory.
 *
 * Harness-only, like the two setters above; production never calls it.
 */
export function textScreenReference(W: number, H: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = get2d(canvas)
  drawTextScreen(g, W, H)
  return g.getImageData(0, 0, W, H)
}

function syntheticScreen(): Generated {
  const { width: W, height: H } = screenSize
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = get2d(canvas)
  const startedAt = performance.now()
  const s = W / 1280
  const content = screenContent
  let frame = 0
  const draw = (): void => {
    const t = (performance.now() - startedAt) / 1000
    if (content === 'text') {
      drawTextScreen(g, W, H)
      return
    }
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
  }
  const loop = paintLoop(draw, screenFps)
  lastScreenLoop = loop
  return { stream: canvas.captureStream(screenFps), stop: loop.stop }
}

const DEFAULT_CAMERA = { width: 640, height: 480 }
let cameraSize = DEFAULT_CAMERA

/**
 * Harness knob, same family as `setSyntheticScreenSize`. F13 needs a PORTRAIT
 * source to prove the frame follows it, and no rig can conjure a phone: this is
 * how a 1080x1920 camera is put in front of the product on the deployed build,
 * in a URL, forever. Production never calls it.
 */
export function setSyntheticCameraSize(size: { width: number; height: number } | null): void {
  cameraSize = size ?? DEFAULT_CAMERA
}

/**
 * `WxH` out of a URL parameter, or null. Used for `screensize=` and `camsize=`,
 * the two test-only knobs that let a portrait or 4K take be reproduced from a
 * link on the deployed build instead of only from a rig runner.
 */
export function parseSizeParam(search: string, key: string): { width: number; height: number } | null {
  const raw = new URLSearchParams(search).get(key)
  const m = raw ? /^(\d{2,5})x(\d{2,5})$/.exec(raw) : null
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/** Apply `?screensize=` / `?camsize=` for this load. Called once, from the
 *  synthetic path only, so nothing outside `?synthetic=1` can reach it. */
export function applySyntheticSizeParams(search: string): void {
  const screen = parseSizeParam(search, 'screensize')
  if (screen) setSyntheticScreenSize(screen)
  const camera = parseSizeParam(search, 'camsize')
  if (camera) setSyntheticCameraSize(camera)
  setSyntheticScreenFps(parseFpsParam(search, 'screenfps'))
  setSyntheticCameraFps(parseFpsParam(search, 'camfps'))
}

/**
 * Harness knobs `?screenfps=` / `?camfps=` — REPRODUCE A 60 fps SOURCE WITHOUT
 * ONE. F15 needs a source that offers more than 30 to prove the rate follows
 * it, and no rig can conjure a 120 Hz gaming monitor or a 60 fps sensor: a
 * canvas capture stream asked for 60 is one, and the deployed build can be
 * driven to it from a URL, forever. Production never calls these.
 */
export function setSyntheticScreenFps(fps: number | null): void {
  screenFps = fps && fps > 0 ? fps : DEFAULT_SYNTHETIC_FPS
}

export function setSyntheticCameraFps(fps: number | null): void {
  cameraFps = fps && fps > 0 ? fps : DEFAULT_SYNTHETIC_FPS
}

/** An integer rate out of a URL parameter, or null. Bounded at 120 so a typo
 *  cannot ask a canvas for a rate no display can source. */
export function parseFpsParam(search: string, key: string): number | null {
  const raw = new URLSearchParams(search).get(key)
  const n = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 && n <= 120 ? n : null
}

function syntheticCamera(): Generated {
  const { width: W, height: H } = cameraSize
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = get2d(canvas)
  // The bouncing disc keeps its size relative to the SHORT side, so a portrait
  // camera shows the same picture turned, not a squashed one.
  const r = Math.round((48 / 480) * Math.min(W, H))
  let x = W / 2
  let y = H / 2
  const s = Math.min(W, H) / 480
  let vx = 4.2 * s
  let vy = 3.1 * s
  const draw = (): void => {
    g.fillStyle = '#7f7f7f'
    g.fillRect(0, 0, W, H)
    x += vx
    y += vy
    if (x < r || x > W - r) {
      vx = -vx
      x = Math.max(r, Math.min(W - r, x))
    }
    if (y < r || y > H - r) {
      vy = -vy
      y = Math.max(r, Math.min(H - r, y))
    }
    g.fillStyle = '#e2554f'
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  const loop = paintLoop(draw, cameraFps)
  lastCameraLoop = loop
  return { stream: canvas.captureStream(cameraFps), stop: loop.stop }
}

/**
 * H4: the `?dead=` source — a video track that is live, unmuted, correctly
 * described and delivers NOT ONE FRAME.
 *
 * MEASURED, NOT ASSUMED (2026-09-01): the obvious fixture — a canvas captured
 * at rate 0, whose `requestFrame()` is never called — is WRONG. It emits one
 * initial frame at capture, which the raw channel duly encoded
 * (`measured video camera first-frame +45ms 640x480@30`) and the compositor
 * counted. One frame is not zero frames, and B4's real camera wrote a 28-byte
 * file, which is a container holding nothing at all.
 *
 * `MediaStreamTrackGenerator` is a writable track: it is 'live' and unmuted the
 * moment it is constructed and produces frames only when something writes them,
 * which nothing here does. It reports no width/height of its own, so it is
 * dressed in the size and rate B4's camera reported while it delivered nothing.
 * The canvas is kept as the fallback for a browser without it — one frame is
 * still a dead source everywhere it matters, just not a perfect one.
 */
function syntheticDeadSource(size: { width: number; height: number }, fps: number): Generated {
  const settings = { width: size.width, height: size.height, frameRate: fps }
  const dress = (track: MediaStreamTrack): void => {
    const real = track.getSettings.bind(track)
    Object.defineProperty(track, 'getSettings', {
      configurable: true,
      value: (): MediaTrackSettings => ({ ...real(), ...settings }),
    })
  }
  const Gen = (globalThis as { MediaStreamTrackGenerator?: new (o: { kind: string }) => MediaStreamTrack })
    .MediaStreamTrackGenerator
  if (Gen) {
    const track = new Gen({ kind: 'video' })
    dress(track)
    return { stream: new MediaStream([track]), stop: () => track.stop() }
  }
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const g = get2d(canvas)
  g.fillStyle = '#000000'
  g.fillRect(0, 0, size.width, size.height)
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0]
  if (track) dress(track)
  return { stream, stop: () => undefined }
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

/**
 * HARNESS KNOB, `?camlies=1` — REPRODUCE A PHONE WITHOUT A PHONE.
 *
 * `MediaStreamTrack.getSettings()` describes the SENSOR, and on a phone held
 * portrait it reports 1920x1080 while every frame delivered is 1080x1920. That
 * one lie is the whole of the bug Robert judged F13's first pass on ("preview on
 * phone still wrong proportions and cutted"), and until now no rig could
 * express it — a canvas track always tells the truth about itself. This makes
 * the synthetic camera lie in exactly that way, so the failure and its fix are
 * reproducible on a desktop, from a URL, forever.
 *
 * Production never reaches this: it is applied only inside the synthetic path.
 */
function makeTrackLieAboutOrientation(track: MediaStreamTrack): void {
  const real = track.getSettings.bind(track)
  Object.defineProperty(track, 'getSettings', {
    configurable: true,
    value: (): MediaTrackSettings => {
      const s = real()
      return { ...s, width: s.height, height: s.width }
    },
  })
}

export function createSyntheticChannels(config: CaptureConfig): SyntheticRig {
  // `?screensize=` / `?camsize=`, read here so every synthetic entry point gets
  // them and no rig runner has to remember (a rig that calls the setter
  // directly still wins — it runs after this).
  if (typeof location !== 'undefined') applySyntheticSizeParams(location.search)
  const channels: AcquiredChannel[] = []
  const teardowns: (() => void)[] = []
  const audioCtx = config.mic || config.systemAudio ? new AudioContext() : null

  const add = (kind: AcquiredChannel['kind'], media: AcquiredChannel['media'], gen: Generated): void => {
    channels.push({ kind, media, stream: gen.stream, track: gen.stream.getTracks()[0] })
    teardowns.push(gen.stop)
  }

  const liar =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('camlies') === '1'
  // H4: `?dead=` swaps the painter for a source that never delivers a frame.
  const dead = typeof location !== 'undefined' ? parseDeadChannels(location.search) : new Set<ChannelKind>()
  if (config.screen) {
    add('screen', 'video', dead.has('screen') ? syntheticDeadSource(screenSize, screenFps) : syntheticScreen())
  }
  if (config.camera) {
    const cam = dead.has('camera') ? syntheticDeadSource(cameraSize, cameraFps) : syntheticCamera()
    if (liar) {
      const t = cam.stream.getVideoTracks()[0]
      if (t) makeTrackLieAboutOrientation(t)
    }
    add('camera', 'video', cam)
  }
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

  // The arming timeline is what drives the "Waiting for microphone…" line, and
  // that line IS the bug the `slow=` knob exists to reproduce. Without these
  // marks the harness could stall a channel for twenty seconds and the UI
  // showed a bare "Starting…" the whole time, so the one symptom Robert
  // reports could only ever be chased against real hardware.
  const t0 = performance.now()
  // The timeline names the screen step 'display' — it is the picker, not the
  // channel. Everything else is one-to-one with the channel kind.
  const stepOf = (kind: ChannelKind): ArmingStep => (kind === 'screen' ? 'display' : kind)
  const mark = (kind: ChannelKind, status: 'start' | 'done'): void =>
    handlers.onProgress?.({ step: stepOf(kind), status, tMs: performance.now() - t0 })

  /**
   * THE CAP PRODUCTION APPLIES, APPLIED HERE TOO (O4-polish). The real acquirer
   * runs capDisplayTrack on the display track before delivering it, and
   * synthetic mode bypassed that path entirely — so a rig driving
   * createCaptureSession over a 4K synthetic screen was measuring the UNCAPPED
   * regime, the one CAPTURE_MAX_* exists to prevent. A canvas track DOES honour
   * the constraint (3840×2160 → 1920×1080@30, `npm run exp -- capcheck`), which
   * is what makes this possible and was worth checking rather than assuming.
   * Rigs that deliberately want uncapped 4K drive liveComposite directly and
   * never come through here, so this narrows nothing they measure.
   */
  const capScreen = async (ch: AcquiredChannel): Promise<void> => {
    if (ch.kind !== 'screen') return
    await capDisplayTrack(ch.track)
  }

  const deliveries = rig.channels.map((ch) => {
    mark(ch.kind, 'start')
    return new Promise<void>((resolve) => {
      const emit = (): void => {
        if (disposed) {
          resolve()
          return
        }
        // AWAITED BEFORE DELIVERY, exactly as the real acquirer does it. The
        // first version fired this and delivered in the same tick, which would
        // have re-constrained the track MID-TAKE — changing a channel's frame
        // size after its recorder had started, which is the one thing the tail
        // drain is careful never to do (P0-tail-raw keeps the size and drops
        // only the rate).
        void capScreen(ch)
          .catch(() => undefined)
          .then(() => {
            if (!disposed) {
              handlers.onChannel(ch)
              mark(ch.kind, 'done')
              if (ch.kind === primary) primaryResolve()
            }
            resolve()
          })
      }
      const delay = delays.get(ch.kind) ?? 0
      if (delay > 0) timers.push(setTimeout(emit, delay))
      else queueMicrotask(emit)
    })
  })

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
