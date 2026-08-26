/**
 * EXPERIMENTAL — X5's premise, measured before X5 is built.
 *
 * THE TASK'S PREMISE, verbatim: "the render composites through a 2D
 * OffscreenCanvas — the EXACT mistake capture measured (~150 ms per 1080p frame
 * readback, 6.7 fps) and fixed with compositorGL (0.86 ms) — every frame pays
 * GPU→CPU readback + CPU composite + CPU→GPU upload for the encoder."
 *
 * IT IS NOT OBVIOUSLY THE SAME MISTAKE, AND THE DIFFERENCE IS WHERE THE PIXELS
 * LIVE. Capture's frames come from MediaStreamTrackProcessor: a captured
 * VideoFrame is a GPU texture, and drawImage-ing it into a 2D context drags it
 * back across the bus — that is the 150 ms. The RENDER's frames come from a
 * software VP9 decoder, so they are already in CPU memory. A CPU→CPU blit is
 * not a readback, and the render's own stage split says so: 2-4 ms per 1080p
 * frame, not 150. Going to GL would ADD an upload (CPU→GPU per frame) that the
 * 2D path does not pay, and might well be slower.
 *
 * So this rig answers the only question that decides whether to write the
 * shader: composite the SAME decoded frames both ways and time them.
 *
 *   twoD          drawVideoFrame into an OffscreenCanvas 2D — the shipped path
 *   glEnqueue     the GL painter, timing only the JS calls (what a naive
 *                 measurement would report, and it is not the cost)
 *   glFinished    the same with gl.finish() per frame, so the GPU work is
 *                 actually inside the measurement — this is the honest number,
 *                 because the encoder reads the canvas every frame and that
 *                 read forces the same synchronisation
 *
 * PARITY IS MEASURED ON THE DEFAULT COMPOSITION ONLY, deliberately: the default
 * is the case the GL painter already implements (capture uses it), so it is the
 * one that can be compared today. F3 backgrounds, F4 poses and F2 viewports are
 * what X5 would have to ADD, and there is no point pricing that work before
 * knowing whether the port pays at all.
 */
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { createGLCompositor } from '@core/capture/compositorGL'
import { drawVideoFrame, type FrameCanvas } from '@core/compose/layout'
import { openVideoChannel, type VideoChannelReader } from '@core/compose/video'
import type { ChannelRecording } from '@core/types'
import { motionSource, screenLikeSource, recordChannels, type Source } from './bitsAudit'

const W = 1920
const H = 1080

export interface CompositeLane {
  painter: '2d' | 'gl-enqueue' | 'gl-finished'
  order: number
  frames: number
  totalMs: number
  msPerFrame: number
}

export interface X5Report {
  notes: string[]
  takeSec: number
  frames: number
  lanes: CompositeLane[]
  /** Mean of each painter's lanes, so an order effect cannot decide it. */
  meanMsPerFrame: Record<string, number>
  /** GL against 2D on the honest (finished) lane. >1 = GL is faster. */
  speedup: number
  /** Default composition, same frames: are the two painters the same picture? */
  parity: {
    sampled: number
    psnrDb: number | null
    maxChannelDelta: number | null
    /** Per region, so a global colour shift is distinguishable from an edge. */
    regions: {
      region: string
      psnrDb: number
      max: number
      meanSignedRgb: [number, number, number]
      over8Pct: number
    }[]
    /**
     * AN ATTEMPT AT A REFEREE THAT TURNED OUT NOT TO BE ONE, kept because the
     * next person will reach for it too. The idea: the screen source is drawn
     * 1:1 at the origin, so the screen region of either output IS that frame
     * converted to RGB, and `VideoFrame.copyTo({format:'RGBA'})` makes WebCodecs
     * do that conversion itself — so whichever painter matches it is right.
     * MEASURED: both painters sit ~20.7 dB from copyTo (max 244) while sitting
     * 37 dB from EACH OTHER. A referee further from both contestants than they
     * are from each other is not a referee; copyTo is applying its own
     * range/matrix convention. Reported, never used to decide anything.
     */
    vsWebCodecs: {
      twoD: { psnrDb: number; max: number; over8Pct: number }
      gl: { psnrDb: number; max: number; over8Pct: number }
    } | null
  }
  verdict: string
}

/** Decode the take once into memory, so the A/B is of painters and not decoders. */
async function decodeFrames(
  reader: VideoChannelReader,
  count: number,
  fps: number,
): Promise<VideoFrame[]> {
  const out: VideoFrame[] = []
  for (let i = 0; i < count; i++) {
    const sample = await reader.sampleAt(i / fps)
    if (!sample) break
    // toVideoFrame() hands out a separate handle; the reader keeps the sample.
    out.push(sample.toVideoFrame())
  }
  return out
}

/**
 * PSNR over a rect, plus the MEAN SIGNED delta per channel — and the second is
 * what tells the two failure modes apart. A geometry disagreement is local: big
 * errors on edges, a mean near zero. A COLOUR disagreement is global: every
 * pixel shifted the same way, so the means come out as a consistent bias. The
 * first version of this rig reported only PSNR and could not have said which.
 */
function comparePatch(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
): { db: number; max: number; meanSigned: [number, number, number]; over8Pct: number } {
  let sum = 0
  let n = 0
  let max = 0
  let over8 = 0
  const signed: [number, number, number] = [0, 0, 0]
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * width + x) * 4
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = a[i + c]! - b[i + c]!
        signed[c] += d
        const ad = Math.abs(d)
        if (ad > worst) worst = ad
        if (ad > max) max = ad
        sum += d * d
        n++
      }
      if (worst > 8) over8++
    }
  }
  const px = Math.max(1, rect.w * rect.h)
  const mse = sum / Math.max(1, n)
  const r1 = (v: number): number => Math.round((v / px) * 100) / 100
  return {
    db: mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10,
    max,
    meanSigned: [r1(signed[0]), r1(signed[1]), r1(signed[2])],
    over8Pct: Math.round((over8 / px) * 1000) / 10,
  }
}

export async function runGlComposite(
  opts: { takeSec?: number; frames?: number; repeats?: number } = {},
): Promise<X5Report> {
  const takeSec = opts.takeSec ?? 12
  const takeMs = takeSec * 1000
  // A SMALL WORKING SET, REPEATED — and the first version got this wrong in a
  // way that read as a painter difference. Holding 240 frames of both channels
  // alive is over a gigabyte of decoded VideoFrames, which the render never
  // does (it holds one per channel), and under that pressure the 2D lane
  // degraded 3.8 -> 7.7 -> 14.3 ms/frame across three rounds while GL barely
  // moved. That is a memory-pressure measurement wearing a painter's name.
  const wantFrames = opts.frames ?? 60
  const repeats = opts.repeats ?? 4
  const notes: string[] = []

  const screenSource: Source = screenLikeSource(W, H)
  const cameraSource: Source = motionSource(1280, 720)
  const channels: ChannelRecording[] = []
  const screenFrames: VideoFrame[] = []
  const cameraFrames: VideoFrame[] = []
  let readers: VideoChannelReader[] = []

  try {
    const [screenCh, cameraCh] = await Promise.all([
      recordChannels(screenSource, 'screen', takeMs, [8_000_000]).then((c) => c[0]!),
      recordChannels(cameraSource, 'camera', takeMs, [2_500_000]).then((c) => c[0]!),
    ])
    channels.push(screenCh, cameraCh)

    for (const ch of channels) {
      const blob = await blobStore.read(ch.blobKey)
      const reader = await openVideoChannel(blob, ch.id, ch.kind, ch.durationMs / 1000)
      if (!reader) throw new Error(`x5: ${ch.kind} channel has no decodable track`)
      readers.push(reader)
    }
    screenFrames.push(...(await decodeFrames(readers[0]!, wantFrames, 30)))
    cameraFrames.push(...(await decodeFrames(readers[1]!, wantFrames, 30)))
    for (const r of readers) r.dispose()
    readers = []

    const frames = Math.min(screenFrames.length, cameraFrames.length)
    if (frames === 0) throw new Error('x5: no frames decoded')
    notes.push(
      `${frames} frames of both channels decoded into memory before the A/B (so this measures painters and not decoders), each lane painting them ${repeats}× = ${frames * repeats} frames`,
    )

    // --- the two painters -------------------------------------------------
    const canvas2d = new OffscreenCanvas(W, H)
    const ctx = canvas2d.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('x5: no 2D context')
    const frame: FrameCanvas = { ctx, width: W, height: H, scale: W / 1920 }

    const glc = createGLCompositor(W, H)
    if (!glc) throw new Error('x5: no WebGL2 — the port has no fast path to measure')

    // A VideoSample-shaped view of a VideoFrame, so the SHIPPED drawVideoFrame
    // can paint frames this rig decoded. Only the members layout.ts touches.
    const asSample = (f: VideoFrame): Parameters<typeof drawVideoFrame>[1] =>
      ({
        displayWidth: f.displayWidth,
        displayHeight: f.displayHeight,
        draw: (
          c: OffscreenCanvasRenderingContext2D,
          x: number,
          y: number,
          w: number,
          h: number,
        ) => c.drawImage(f, x, y, w, h),
        drawWithFit: (c: OffscreenCanvasRenderingContext2D, o: { fit: 'contain' | 'cover' }) => {
          const s =
            o.fit === 'contain'
              ? Math.min(W / f.displayWidth, H / f.displayHeight)
              : Math.max(W / f.displayWidth, H / f.displayHeight)
          const dw = f.displayWidth * s
          const dh = f.displayHeight * s
          c.drawImage(f, (W - dw) / 2, (H - dh) / 2, dw, dh)
        },
      }) as unknown as Parameters<typeof drawVideoFrame>[1]

    const paint2d = (i: number): void => {
      drawVideoFrame(frame, asSample(screenFrames[i]!), asSample(cameraFrames[i]!), false)
    }
    const paintGl = (i: number): void => {
      const s = screenFrames[i]!
      const cam = cameraFrames[i]!
      glc.begin(true)
      const fit = Math.min(W / s.displayWidth, H / s.displayHeight)
      const dw = s.displayWidth * fit
      const dh = s.displayHeight * fit
      glc.draw(s, (W - dw) / 2, (H - dh) / 2, dw, dh, 0, 0)
      const scale = W / 1920
      const pw = 0.24 * W
      const ph = pw / (cam.displayWidth / cam.displayHeight)
      const margin = 24 * scale
      glc.draw(cam, W - pw - margin, H - ph - margin, pw, ph, 16 * scale, 1.5 * scale)
    }

    const lane = (
      painter: CompositeLane['painter'],
      order: number,
    ): CompositeLane => {
      const t0 = performance.now()
      for (let r = 0; r < repeats; r++) {
        for (let i = 0; i < frames; i++) {
          if (painter === '2d') paint2d(i)
          else {
            paintGl(i)
            if (painter === 'gl-finished') glc.finish()
          }
        }
      }
      const totalMs = performance.now() - t0
      const painted = frames * repeats
      return {
        painter,
        order,
        frames: painted,
        totalMs: Math.round(totalMs),
        msPerFrame: Math.round((totalMs / painted) * 1000) / 1000,
      }
    }

    // Warm both painters with a discarded pass — note 10(a), the first lane of
    // any matrix pays a cold start and reads as a difference between engines.
    paint2d(0)
    paintGl(0)
    glc.finish()
    notes.push('both painters warmed with a discarded frame before measuring')

    // INTERLEAVED, AND SCORED ON THE MINIMUM. The first version ran A,B,B,A and
    // read the same painter at 3.95 and 6.96 ms/frame in one run — the machine
    // drifts (later lanes are consistently slower), so a mean of two lanes is a
    // measurement of when they happened to run. Interleaving and taking each
    // painter's BEST lane is the standard answer to a drifting host: the fastest
    // observation is the one least polluted by whatever else the machine did.
    const lanes: CompositeLane[] = []
    let order = 0
    for (let round = 0; round < 3; round++) {
      lanes.push(lane('2d', ++order))
      lanes.push(lane('gl-finished', ++order))
      lanes.push(lane('gl-enqueue', ++order))
    }

    const bestOf = (p: CompositeLane['painter']): number =>
      Math.min(...lanes.filter((l) => l.painter === p).map((l) => l.msPerFrame))
    const meanMsPerFrame = {
      '2d': bestOf('2d'),
      'gl-enqueue': bestOf('gl-enqueue'),
      'gl-finished': bestOf('gl-finished'),
    }
    const spread = (p: CompositeLane['painter']): number => {
      const xs = lanes.filter((l) => l.painter === p).map((l) => l.msPerFrame)
      return Math.round((Math.max(...xs) / Math.min(...xs)) * 100) / 100
    }
    notes.push(
      `lanes are INTERLEAVED and scored on each painter's BEST, because the host drifts: ` +
        `worst/best within one painter is ${spread('2d')}× (2d) and ${spread('gl-finished')}× (gl)`,
    )
    const speedup = Math.round((meanMsPerFrame['2d'] / meanMsPerFrame['gl-finished']) * 100) / 100

    // --- parity, default composition -------------------------------------
    let parity: X5Report['parity'] = {
      sampled: 0,
      psnrDb: null,
      maxChannelDelta: null,
      regions: [],
      vsWebCodecs: null,
    }
    {
      const readCtx = canvas2d.getContext('2d', { willReadFrequently: true })
      const glRead = new OffscreenCanvas(W, H)
      const glReadCtx = glRead.getContext('2d', { willReadFrequently: true })
      if (readCtx && glReadCtx) {
        const i = Math.floor(frames / 2)
        paint2d(i)
        const a = readCtx.getImageData(0, 0, W, H).data
        paintGl(i)
        glc.finish()
        glReadCtx.clearRect(0, 0, W, H)
        glReadCtx.drawImage(glc.canvas, 0, 0)
        const b = glReadCtx.getImageData(0, 0, W, H).data

        // The screen picture, well inside its own edges; the PiP, well inside
        // its rounded corners; and a letterbox band that is pure black in both.
        // Three regions, three different things that can be wrong.
        const s = screenFrames[i]!
        const fit = Math.min(W / s.displayWidth, H / s.displayHeight)
        const dw = s.displayWidth * fit
        const dh = s.displayHeight * fit
        const sx = Math.round((W - dw) / 2)
        const sy = Math.round((H - dh) / 2)
        const cam = cameraFrames[i]!
        const scale = W / 1920
        const pw = 0.24 * W
        const ph = pw / (cam.displayWidth / cam.displayHeight)
        const margin = 24 * scale
        const px = Math.round(W - pw - margin)
        const py = Math.round(H - ph - margin)
        const inset = 40
        const regions = [
          {
            region: 'screen picture (interior)',
            rect: {
              x: sx + inset,
              y: sy + inset,
              w: Math.max(1, Math.round(dw) - 2 * inset),
              h: Math.max(1, Math.round(dh) - 2 * inset),
            },
          },
          {
            region: 'camera PiP (interior)',
            rect: {
              x: px + inset,
              y: py + inset,
              w: Math.max(1, Math.round(pw) - 2 * inset),
              h: Math.max(1, Math.round(ph) - 2 * inset),
            },
          },
          {
            region: 'whole frame',
            rect: { x: 0, y: 0, w: W, h: H },
          },
        ]
        const rows = regions
          .filter((r) => r.rect.x >= 0 && r.rect.y >= 0 && r.rect.w > 0 && r.rect.h > 0)
          .map((r) => {
            const c = comparePatch(a, b, W, r.rect)
            return {
              region: r.region,
              psnrDb: c.db,
              max: c.max,
              meanSignedRgb: c.meanSigned,
              over8Pct: c.over8Pct,
            }
          })
        // The third party: ask WebCodecs to convert the same frame to RGBA and
        // compare BOTH painters against it, over the screen interior only (the
        // one region where the output is that frame 1:1).
        let vsWebCodecs: X5Report['parity']['vsWebCodecs'] = null
        try {
          const rect = {
            x: 0,
            y: 0,
            width: s.displayWidth,
            height: s.displayHeight,
          }
          const size = s.allocationSize({ format: 'RGBA', rect })
          const buf = new Uint8ClampedArray(size)
          await s.copyTo(buf, { format: 'RGBA', rect })
          const interior = {
            x: sx + inset,
            y: sy + inset,
            w: Math.max(1, Math.round(dw) - 2 * inset),
            h: Math.max(1, Math.round(dh) - 2 * inset),
          }
          // The reference buffer is frame-local; the outputs are frame-global,
          // and the screen sits at (sx, sy). Shift the reference into place.
          const ref = new Uint8ClampedArray(W * H * 4)
          for (let y = 0; y < s.displayHeight && y + sy < H; y++) {
            const src = y * s.displayWidth * 4
            const dst = ((y + sy) * W + sx) * 4
            ref.set(buf.subarray(src, src + s.displayWidth * 4), dst)
          }
          const a2 = comparePatch(a, ref, W, interior)
          const g2 = comparePatch(b, ref, W, interior)
          vsWebCodecs = {
            twoD: { psnrDb: a2.db, max: a2.max, over8Pct: a2.over8Pct },
            gl: { psnrDb: g2.db, max: g2.max, over8Pct: g2.over8Pct },
          }
        } catch (err) {
          notes.push(`vsWebCodecs reference unavailable: ${String(err)}`)
        }

        const whole = rows.find((r) => r.region === 'whole frame')
        parity = {
          sampled: 1,
          psnrDb: whole?.psnrDb ?? null,
          maxChannelDelta: whole?.max ?? null,
          regions: rows,
          vsWebCodecs,
        }
      }
    }

    glc.dispose()

    const textParity = parity.regions.find((r) => r.region === 'screen picture (interior)')
    const verdict =
      textParity && textParity.psnrDb < 60
        ? `REFUSED ON ITS OWN GATE. GL is ${speedup}x the 2D painter per frame, but the two painters ` +
          `do not draw the same picture: on the screen's TEXT the interior reads ${textParity.psnrDb} dB ` +
          `(max ${textParity.max} of 255, ${textParity.over8Pct}% of pixels off by more than 8) against a gate of ` +
          `<=1 LSB or >=60 dB — and that is the DEFAULT composition, the one the GL painter already ` +
          `implements, before any F3/F4/F2 shader work exists. The smooth camera region agrees ` +
          `(max ${parity.regions.find((r) => r.region === 'camera PiP (interior)')?.max}), so this is sharp-edge colour handling, not geometry.`
        : `GL is ${speedup}x the 2D painter and the default composition matches to ${textParity?.psnrDb} dB — ` +
          `the port clears its parity gate on the easy case, and the F3 shadow / F2 viewport shader work is what to price next.`

    notes.push(
      'the GL lane includes the per-frame texture upload of a CPU-backed decoded frame, which is the cost the 2D path does not pay and the premise did not account for',
    )
    notes.push(
      'gl-enqueue is reported to show what a careless measurement would claim: GL draw calls return before the GPU has done anything, so timing them times the enqueue',
    )

    return {
      notes,
      takeSec,
      frames,
      lanes,
      meanMsPerFrame,
      speedup,
      parity,
      verdict,
    }
  } finally {
    for (const r of readers) r.dispose()
    for (const f of screenFrames) f.close()
    for (const f of cameraFrames) f.close()
    screenSource.stop()
    cameraSource.stop()
    for (const ch of channels) await blobStore.remove(ch.blobKey).catch(() => undefined)
    void newId
  }
}
