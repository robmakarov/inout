/**
 * O4's PARITY GATE — the WebGPU painter and the WebGL2 painter, on the SAME
 * frames, compared pixel by pixel.
 *
 * The gate this answers, from .ai/TASKS: "pixel parity with compositorGL within
 * the chroma rig's bands, both painters required identical". An unedited export
 * packet-copies the capture composite and the editor re-draws the same layout
 * through compose/layout.ts, so a painter that is a shade off is a visible jump
 * on the way into the editor and a colour the chroma rig will find later.
 *
 * IT IMPORTS THE PRODUCT'S PAINTERS. Not a copy of the shaders — a parity test
 * written against its own copy of the thing it is testing proves that the copy
 * agrees with itself. `createGLCompositor` and `createWGPUCompositor` here are
 * the ones capture ships.
 *
 * IT WANTS A REAL CAPTURE FRAME, and the reason is the whole task: WebGPU's
 * `importExternalTexture` binds the frame's PLANES, so an NV12 screen-capture
 * frame goes through a multiplanar YUV→RGB conversion that a BGRA canvas frame
 * never touches. A parity run on a synthetic source would test the one path
 * where the two painters cannot disagree. So `display` is the lane that counts
 * and `canvas` is only the control — and the run says which it got.
 *
 * THE COMPOSITION IS THE ONE CAPTURE DRAWS: a letterboxed screen on black, plus
 * the camera PiP with its rounded corners and its 25 %-white stroke. The corners
 * are where the two shaders could most easily differ (a signed-distance field,
 * a smoothstep and a blend), so a parity run without the PiP would be reporting
 * on the easy half.
 *
 * WHAT IT REPORTS is a difference histogram, not a verdict dressed as one: max
 * absolute channel difference, the share of pixels off by more than 1, 2 and 4,
 * and PSNR — plus the same numbers for the PiP's corner region alone, because a
 * disagreement confined to a few hundred edge pixels is a different finding
 * from a disagreement spread over the frame.
 */
import { createGLCompositor, type GLCompositor } from '@core/capture/compositorGL'
import { createWGPUCompositor, wgpuDevice, type WGPUCompositor } from '@core/capture/compositorWGPU'

export interface ParityStats {
  /** Largest absolute difference on any of R, G, B, over all pixels. */
  maxAbs: number
  meanAbs: number
  /** COUNT of pixels where any channel differs by more than N. A share rounds
   *  a hundred bad pixels in two million to "0.0000 %", which is how the first
   *  read of this rig nearly reported a real difference as none. */
  over1: number
  over2: number
  over4: number
  psnrDb: number
  pixels: number
  /** Where the worst pixel is, and what each painter put there. */
  worstAt: { x: number; y: number; a: number[]; b: number[] } | null
  /** The twelve worst, so a PATTERN is visible rather than one anecdote — a
   *  single pixel cannot tell a clamp from a rounding difference. */
  worst12: { x: number; y: number; a: number[]; b: number[]; d: number }[]
  /**
   * BT.709 luma of each painter's value at the worst pixels, and the largest
   * luma difference among them. THE DISCRIMINATING NUMBER: if the two painters
   * disagree only about CHROMA, luma is identical and the difference is NV12
   * chroma reconstruction — not the shader, not the geometry, not the range.
   */
  lumaMaxDiff: number | null
}

export interface PainterParityResult {
  lane: 'display' | 'canvas'
  source: {
    width: number
    height: number
    format: string | null
    /** THE FRAME'S OWN TAGGING. The canvas lane and the display lane disagree
     *  about parity, so what differs is the frames, and this is the field that
     *  says how. */
    colorSpace: Record<string, unknown> | null
  } | null
  composite: { width: number; height: number }
  backends: { webgpu: boolean; webgl2: boolean }
  frames: number
  /** Whole-frame parity, and the PiP's corner box on its own. */
  whole: ParityStats | null
  pip: ParityStats | null
  /**
   * Paint cost per frame with a REAL fence and no readback: BATCH composes
   * behind one wait, so the fence is amortised instead of dominating. GL fences
   * with compositorGL.finish() (gl.finish + a one-pixel readPixels, because
   * gl.finish alone does not wait — O4 step 1); WebGPU fences with
   * queue.onSubmittedWorkDone(). The readback-per-frame number this rig used to
   * print swung 8-28 ms run to run and measured the readback, not the paint.
   */
  costMs: { webgpu: number | null; webgl2: number | null; batch: number }
  /** PNG data URLs: the full composite from each painter, and a 4x nearest
   *  blow-up of the worst region from each. The repo's rule is that a picture
   *  a user could see does not move without Robert looking at an A/B first. */
  images: { gpuFull: string; glFull: string; gpuCrop: string; glCrop: string } | null
  /** Mean RGB of each painter's own snapshot, and a corner sample from each.
   *  A parity failure is meaningless until it is known that BOTH canvases
   *  actually contain a picture — a blank one reads as "totally different". */
  levels: { webgpu: number | null; webgl2: number | null; sampleGpu: number[]; sampleGl: number[] } 
  notes: string[]
}

/** Chromium-only, and still absent from the TS DOM lib. */
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
}

/**
 * The composite's size. NOT a constant, and the reason is the finding this rig
 * produced: the two painters agree exactly when the source is drawn 1:1 and
 * disagree only where it is MINIFIED (a 3024x1964 screen into a 1080p
 * composite). `matchSource` composes at the frame's own size so that claim can
 * be tested instead of asserted.
 */
let W = 1920
let H = 1080

/** The PiP slot capture draws into, at this composite's scale. Kept in one
 *  place so both painters are handed the identical rect and any difference is
 *  the shader's and not the caller's. */
function pipRect(): { x: number; y: number; w: number; h: number; r: number; border: number } {
  const scale = W / 1920
  const w = Math.round(420 * scale)
  const h = Math.round(236 * scale)
  const margin = 24 * scale
  return { x: W - w - margin, y: H - h - margin, w, h, r: 18 * scale, border: 2 * scale }
}

/** Paint the capture composition through whichever painter is handed in. */
function compose(p: GLCompositor | WGPUCompositor, frame: VideoFrame): void {
  p.begin(true)
  const s = Math.min(W / frame.displayWidth, H / frame.displayHeight)
  const dw = frame.displayWidth * s
  const dh = frame.displayHeight * s
  p.draw(frame, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
  const r = pipRect()
  p.draw(frame, r.x, r.y, r.w, r.h, r.r, r.border)
  ;(p as WGPUCompositor).end?.()
}

function statsOf(a: Uint8ClampedArray, b: Uint8ClampedArray, box?: { x: number; y: number; w: number; h: number }): ParityStats {
  let maxAbs = 0
  let sumAbs = 0
  let sumSq = 0
  let over1 = 0
  let over2 = 0
  let over4 = 0
  let n = 0
  let wx = -1
  let wy = -1
  const top: { x: number; y: number; a: number[]; b: number[]; d: number }[] = []
  const x0 = box?.x ?? 0
  const y0 = box?.y ?? 0
  const x1 = box ? box.x + box.w : W
  const y1 = box ? box.y + box.h : H
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c] - b[i + c])
        if (d > worst) worst = d
        sumAbs += d
        sumSq += d * d
      }
      if (worst > maxAbs) {
        maxAbs = worst
        wx = x
        wy = y
      }
      if (worst > 4) {
        const i2 = i
        top.push({
          x,
          y,
          d: worst,
          a: [a[i2], a[i2 + 1], a[i2 + 2]],
          b: [b[i2], b[i2 + 1], b[i2 + 2]],
        })
        if (top.length > 512) {
          top.sort((p, q) => q.d - p.d)
          top.length = 64
        }
      }
      if (worst > 1) over1++
      if (worst > 2) over2++
      if (worst > 4) over4++
      n++
    }
  }
  const mse = sumSq / (n * 3)
  return {
    maxAbs,
    meanAbs: sumAbs / (n * 3),
    over1,
    over2,
    over4,
    // A perfect match has no noise to report a ratio against. 999 rather than
    // Infinity, which JSON.stringify turns into null on the way out of the
    // harness and which would then read as "not measured".
    psnrDb: mse === 0 ? 999 : 10 * Math.log10((255 * 255) / mse),
    pixels: n,
    worst12: top.sort((p, q) => q.d - p.d).slice(0, 12),
    lumaMaxDiff: top.length
      ? Math.max(
          ...top.slice(0, 64).map((t) => {
            const y = (v: number[]): number => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
            return Math.abs(y(t.a) - y(t.b))
          }),
        )
      : null,
    worstAt:
      wx < 0
        ? null
        : {
            x: wx,
            y: wy,
            a: [a[(wy * W + wx) * 4], a[(wy * W + wx) * 4 + 1], a[(wy * W + wx) * 4 + 2]],
            b: [b[(wy * W + wx) * 4], b[(wy * W + wx) * 4 + 1], b[(wy * W + wx) * 4 + 2]],
          },
  }
}

/** A canvas that repaints every frame, for the control lane and as the source
 *  when no display can be captured. */
function canvasStream(width: number, height: number): MediaStream {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')!
  let n = 0
  const paint = (): void => {
    n++
    g.fillStyle = `hsl(${(n * 7) % 360},70%,45%)`
    g.fillRect(0, 0, width, height)
    g.fillStyle = '#fff'
    g.font = `${Math.round(height / 8)}px sans-serif`
    g.fillText('parity', 40, height / 2)
    g.fillStyle = '#0f0'
    g.fillRect((n * 13) % Math.max(1, width - 200), (n * 7) % Math.max(1, height - 200), 200, 200)
    requestAnimationFrame(paint)
  }
  paint()
  return (c as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(60)
}

export async function runPainterParity(
  opts: { frames?: number; lane?: 'display' | 'canvas'; matchSource?: boolean } = {},
): Promise<PainterParityResult> {
  const want = opts.frames ?? 24
  W = 1920
  H = 1080
  const notes: string[] = []
  const out: PainterParityResult = {
    lane: opts.lane ?? 'display',
    source: null,
    composite: { width: W, height: H },
    backends: { webgpu: false, webgl2: false },
    frames: 0,
    whole: null,
    pip: null,
    costMs: { webgpu: null, webgl2: null, batch: 0 },
    images: null,
    levels: { webgpu: null, webgl2: null, sampleGpu: [], sampleGl: [] },
    notes,
  }

  let stream: MediaStream | null = null
  if (out.lane === 'display') {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: false,
      })
    } catch (err) {
      notes.push(`display capture refused (${String(err)}) — falling back to the canvas control`)
      out.lane = 'canvas'
    }
  }
  if (!stream) stream = canvasStream(1920, 1080)

  const track0 = stream.getVideoTracks()[0]
  if (opts.matchSource) {
    const st = track0.getSettings()
    if (st.width && st.height) {
      // Even dimensions: an NV12 frame has none other, and a composite that is
      // odd would introduce a resample of its own.
      W = st.width - (st.width % 2)
      H = st.height - (st.height % 2)
      notes.push(`composite matched to the source at ${W}x${H} — no minification in the screen draw`)
    }
  }

  const device = await wgpuDevice()
  const wgpu = device ? createWGPUCompositor(device, W, H) : null
  const glp = createGLCompositor(W, H)
  out.backends = { webgpu: !!wgpu, webgl2: !!glp }
  if (!wgpu) notes.push('no WebGPU painter on this machine — parity cannot be measured')
  if (!glp) notes.push('no WebGL2 painter on this machine — parity cannot be measured')

  // ONE READBACK CANVAS, used for both painters, so the comparison never
  // includes a difference the readback itself introduced.
  const read = new OffscreenCanvas(W, H)
  const rctx = read.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!rctx) throw new Error('painterParity: no 2d readback context')

  const snapshot = (c: OffscreenCanvas): Uint8ClampedArray => {
    rctx.drawImage(c, 0, 0)
    return rctx.getImageData(0, 0, W, H).data
  }

  const track = track0
  const TP = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor })
    .MediaStreamTrackProcessor
  if (!TP) throw new Error('painterParity: MediaStreamTrackProcessor unavailable')
  const reader = new TP({ track }).readable.getReader()

  const COST_BATCH = 8
  let gpuMs = 0
  let glMs = 0
  let costFrames = 0
  let worstWhole: ParityStats | null = null
  let worstPip: ParityStats | null = null
  let lastA: Uint8ClampedArray | null = null
  let lastB: Uint8ClampedArray | null = null
  const r = pipRect()
  // The corner box: the PiP plus a couple of pixels of the feathering outside
  // it, which is the part of the shader most able to disagree.
  const pipBox = { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), w: r.w + 8, h: r.h + 8 }

  const deadline = performance.now() + 40_000
  try {
    while (out.frames < want && performance.now() < deadline) {
      const { value, done } = await reader.read()
      if (done || !value) break
      if (!out.source) {
        const cs = (value as VideoFrame & { colorSpace?: Record<string, unknown> }).colorSpace
        out.source = {
          width: value.displayWidth,
          height: value.displayHeight,
          format: value.format ? String(value.format) : null,
          colorSpace: cs
            ? {
                primaries: cs.primaries,
                transfer: cs.transfer,
                matrix: cs.matrix,
                fullRange: cs.fullRange,
              }
            : null,
        }
      }
      if (wgpu && glp) {
        // BOTH PAINTERS, SAME TASK, SAME FRAME. Neither canvas preserves its
        // drawing buffer, so each snapshot has to happen before the task yields
        // — and the frame has to stay open across both, which is why it is
        // closed only at the bottom of the loop.
        compose(wgpu, value)
        const a = snapshot(wgpu.canvas)
        compose(glp, value)
        const b = snapshot(glp.canvas)
        // COST, measured separately from parity and with a real fence: the
        // snapshots above are what make parity possible and they are also what
        // made the old cost number meaningless.
        const t0 = performance.now()
        for (let i = 0; i < COST_BATCH; i++) compose(wgpu, value)
        await wgpu.settled()
        const t1 = performance.now()
        for (let i = 0; i < COST_BATCH; i++) compose(glp, value)
        glp.finish()
        const t2 = performance.now()
        gpuMs += (t1 - t0) / COST_BATCH
        glMs += (t2 - t1) / COST_BATCH
        costFrames++
        if (out.frames === 0) {
          const mean = (d: Uint8ClampedArray): number => {
            let t = 0
            for (let i = 0; i < d.length; i += 4 * 97) t += d[i] + d[i + 1] + d[i + 2]
            return t / (3 * Math.ceil(d.length / (4 * 97)))
          }
          const at = (d: Uint8ClampedArray, x: number, y: number): number[] => {
            const i = (y * W + x) * 4
            return [d[i], d[i + 1], d[i + 2], d[i + 3]]
          }
          out.levels = {
            webgpu: mean(a),
            webgl2: mean(b),
            sampleGpu: [...at(a, W / 2, H / 2), ...at(a, 10, 10), ...at(a, W - 60, H - 60)],
            sampleGl: [...at(b, W / 2, H / 2), ...at(b, 10, 10), ...at(b, W - 60, H - 60)],
          }
        }
        const whole = statsOf(a, b)
        const pip = statsOf(a, b, pipBox)
        // Keep the pair belonging to the WORST frame, so the A/B Robert looks
        // at is the frame the numbers are about.
        if (!worstWhole || whole.maxAbs >= worstWhole.maxAbs) {
          lastA = new Uint8ClampedArray(a)
          lastB = new Uint8ClampedArray(b)
        }
        // The WORST frame is what the gate reads: an average would let one bad
        // frame in twenty-four disappear.
        if (!worstWhole || whole.maxAbs > worstWhole.maxAbs) worstWhole = whole
        if (!worstPip || pip.maxAbs > worstPip.maxAbs) worstPip = pip
      }
      out.frames++
      value.close()
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already gone */
    }
    for (const t of stream.getTracks()) t.stop()
    wgpu?.dispose()
    glp?.dispose()
  }

  out.whole = worstWhole
  out.pip = worstPip
  // The A/B pair, cut from the LAST pair of snapshots kept for the purpose.
  if (lastA && lastB) {
    const toCanvas = (d: Uint8ClampedArray): OffscreenCanvas => {
      const c = new OffscreenCanvas(W, H)
      const g = c.getContext('2d')!
      // A fresh, definitely-not-shared buffer: the snapshots are copies taken
      // with `new Uint8ClampedArray(...)`, but TS widens that to ArrayBufferLike
      // and ImageData will not take a possibly-shared one.
      const owned = new Uint8ClampedArray(new ArrayBuffer(d.length))
      owned.set(d)
      g.putImageData(new ImageData(owned, W, H), 0, 0)
      return c
    }
    const CROP = 240
    const ZOOM = 4
    const cx = Math.min(Math.max(0, (worstWhole?.worstAt?.x ?? W / 2) - CROP / 2), W - CROP)
    const cy = Math.min(Math.max(0, (worstWhole?.worstAt?.y ?? H / 2) - CROP / 4), H - CROP / 2)
    const crop = (src: OffscreenCanvas): OffscreenCanvas => {
      const c = new OffscreenCanvas(CROP * ZOOM, (CROP / 2) * ZOOM)
      const g = c.getContext('2d')!
      // Nearest, so a one-level colour difference is a flat block and not a
      // blur the eye reads as the same picture.
      g.imageSmoothingEnabled = false
      g.drawImage(src, cx, cy, CROP, CROP / 2, 0, 0, c.width, c.height)
      return c
    }
    const url = async (c: OffscreenCanvas): Promise<string> => {
      const blob = await c.convertToBlob({ type: 'image/png' })
      const buf = new Uint8Array(await blob.arrayBuffer())
      // Chunked: String.fromCharCode(...buf) on a megabyte blows the argument
      // limit, and the failure looks like a corrupt image rather than a crash.
      let bin = ''
      for (let i = 0; i < buf.length; i += 8192) {
        bin += String.fromCharCode(...buf.subarray(i, i + 8192))
      }
      return 'data:image/png;base64,' + btoa(bin)
    }
    const ca = toCanvas(lastA)
    const cb = toCanvas(lastB)
    out.images = {
      gpuFull: await url(ca),
      glFull: await url(cb),
      gpuCrop: await url(crop(ca)),
      glCrop: await url(crop(cb)),
    }
  }
  if (costFrames > 0) {
    out.costMs = { webgpu: gpuMs / costFrames, webgl2: glMs / costFrames, batch: COST_BATCH }
    notes.push(
      'costMs is the composition (screen draw + PiP draw) behind one real fence per' +
        ` batch of ${COST_BATCH}, on the MAIN thread. Production paints in a worker, so read` +
        ' the difference between the two rather than either absolute.',
    )
  }
  return out
}
