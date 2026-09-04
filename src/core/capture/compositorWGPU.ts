/**
 * WebGPU compositor backend for the capture worker (task O4).
 *
 * WHY IT EXISTS, and the honest size of the prize — measured 2026-09-04 by
 * `scripts/gpu-residency.mjs`, verdict in .ai/DECISIONS, so nobody has to take
 * this file's word for it. A transferred capture VideoFrame is NOT read back:
 * on this Mac it uploads at 0.20-0.38x what the same bytes cost from CPU
 * memory, and the whole paint (upload + a full-size draw) costs 0.29-0.31
 * ms/Mpx, so a 4K composite is ~2.4-2.6 ms per frame and not the 35.6 ms this
 * task was written against (that number was a rig's own 4K canvas source).
 *
 * WHAT THIS BACKEND REMOVES is therefore exactly one thing: the upload, which
 * is 40-50 % of that paint — 0.27-0.49 ms at the 1080p rung, 0.73 ms at
 * 3024x1964, ~1.1 ms projected at 4K, per frame. `importExternalTexture` binds
 * the frame's planes where they already are instead of converting them into an
 * RGBA texture first. Robert's call to build it anyway stands on record
 * (2026-09-04, and robert (20) before it: a 2 % lever is still a lever).
 *
 * IT MUST BE PIXEL-IDENTICAL TO compositorGL. An unedited export packet-copies
 * the capture composite, and the editor re-draws the same layout through
 * compose/layout.ts, so three files have to agree on geometry (layout.ts,
 * compositor.worker.ts, liveComposite.ts) and cameraTrack.ts owns the PiP. The
 * shader below is a line-by-line port of compositorGL's GLSL for that reason —
 * where it looks like it could be written more idiomatically, it is written to
 * match instead.
 *
 * THE TWO CONVENTIONS THAT COULD SILENTLY FLIP THE PICTURE, checked rather than
 * assumed. GL maps NDC y=+1 to the top row of the image (viewport maps +1 to
 * y=height, and its window origin is bottom-left); WebGPU maps NDC y=+1 to
 * framebuffer row 0, which is also the top. Both therefore put a_pos.y=1 at the
 * image top, and both sample v=0 as the source's first row. So the same rect
 * arithmetic and the same v-flip carry over unchanged, and the parity rig
 * (`scripts/painter-parity.mjs`) is what proves it rather than this paragraph.
 *
 * NO MACHINE LOSES A PATH: the worker asks for this backend, falls back to
 * WebGL2 and then to 2D, and every one of the three is a complete painter.
 */

/** Chromium ships WebGPU; the TS DOM lib in this repo does not describe it. */
interface GPUAdapterLike {
  requestDevice(): Promise<GPUDeviceLike>
}
interface GPUDeviceLike {
  addEventListener?(type: string, fn: (e: { error?: { message?: string } }) => void): void
  pushErrorScope(filter: string): void
  popErrorScope(): Promise<{ message?: string } | null>
  readonly queue: {
    writeBuffer(buffer: unknown, offset: number, data: BufferSource): void
    submit(buffers: unknown[]): void
    /** Resolves when everything submitted so far has actually RUN. Submitting
     *  is not waiting, so this is the only honest fence WebGPU offers. */
    onSubmittedWorkDone(): Promise<void>
  }
  readonly lost?: Promise<unknown>
  createShaderModule(d: { code: string }): GPUShaderModuleLike
  createBuffer(d: { size: number; usage: number }): unknown
  createSampler(d: Record<string, unknown>): unknown
  createBindGroupLayout(d: Record<string, unknown>): unknown
  createPipelineLayout(d: Record<string, unknown>): unknown
  createRenderPipeline(d: Record<string, unknown>): unknown
  createBindGroup(d: Record<string, unknown>): unknown
  createCommandEncoder(): GPUCommandEncoderLike
  importExternalTexture(d: { source: VideoFrame }): unknown
  destroy(): void
}
interface GPUShaderModuleLike {
  getCompilationInfo?(): Promise<{
    messages: { type: string; message: string; lineNum: number; linePos: number }[]
  }>
}
interface GPUCommandEncoderLike {
  beginRenderPass(d: Record<string, unknown>): GPURenderPassLike
  finish(): unknown
}
interface GPURenderPassLike {
  setPipeline(p: unknown): void
  setBindGroup(i: number, g: unknown, offsets?: number[]): void
  draw(count: number): void
  end(): void
}
interface GPUCanvasContextLike {
  configure(d: Record<string, unknown>): void
  getCurrentTexture(): { createView(): unknown }
}
interface GPULike {
  requestAdapter(d?: Record<string, unknown>): Promise<GPUAdapterLike | null>
  getPreferredCanvasFormat(): string
}

/** Bit flags from the WebGPU spec; named here so the file reads without them. */
const USAGE_UNIFORM = 0x40
const USAGE_COPY_DST = 0x8
const SHADER_STAGE_VERTEX = 0x1
const SHADER_STAGE_FRAGMENT = 0x2

/**
 * A line-by-line port of compositorGL's shaders. The vertex quad is generated
 * from the vertex index rather than read from a buffer — the same four corners,
 * one less thing to keep in sync.
 */
const SHADER = /* wgsl */ `
struct Uniforms {
  rect     : vec4f,   // x, y, w, h in clip space (-1..1)
  sizePx   : vec2f,   // drawn size in device pixels
  radiusPx : f32,     // 0 = square corners
  borderPx : f32,     // 0 = no border
};
@group(0) @binding(0) var u_samp : sampler;
@group(0) @binding(1) var u_tex  : texture_external;
@group(0) @binding(2) var<uniform> U : Uniforms;

struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f };

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  // The unit quad, as a triangle strip: (0,0) (1,0) (0,1) (1,1).
  var corners = array<vec2f, 4>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  let a = corners[vi];
  var o : VOut;
  // v is flipped exactly as compositorGL's u_flipY=1 branch does: a_pos.y=1 is
  // the image top in both APIs, and the source's first row is v=0 in both.
  o.uv = vec2f(a.x, 1.0 - a.y);
  o.pos = vec4f(U.rect.xy + a * U.rect.zw, 0.0, 1.0);
  return o;
}

/** Signed distance to a rounded box centred on the origin. */
fn sdRoundedBox(p : vec2f, b : vec2f, r : f32) -> f32 {
  let q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

@fragment
fn fs(v : VOut) -> @location(0) vec4f {
  let tex = textureSampleBaseClampToEdge(u_tex, u_samp, v.uv);
  if (U.radiusPx <= 0.0 && U.borderPx <= 0.0) {
    return vec4f(tex.rgb, 1.0);
  }
  let p = (v.uv - 0.5) * U.sizePx;
  let d = sdRoundedBox(p, U.sizePx * 0.5, U.radiusPx);
  // One pixel of feathering: the same softness the 2D clip path produced.
  let inside = 1.0 - smoothstep(-1.0, 1.0, d);
  var rgb = tex.rgb;
  if (U.borderPx > 0.0) {
    let onBorder = 1.0 - smoothstep(-U.borderPx - 1.0, -U.borderPx + 1.0, d);
    // The stroke is white at 25 %, exactly as layout.ts draws it.
    rgb = mix(vec3f(1.0), rgb, clamp(onBorder, 0.0, 1.0) * 0.75 + 0.25);
    rgb = mix(rgb, mix(rgb, vec3f(1.0), 0.25), (1.0 - onBorder) * inside);
  }
  return vec4f(rgb, inside);
}
`

/**
 * One uniform slot per draw in a frame. A dynamic offset has to be 256-byte
 * aligned, so the 32 bytes this shader needs cost a 256-byte stride; 8 slots is
 * 2 KB for a composition that draws two things, which is room to spare rather
 * than a limit anyone will meet.
 */
const UNIFORM_STRIDE = 256
const UNIFORM_SLOTS = 8

function gpuOf(): GPULike | null {
  const g = globalThis as unknown as { navigator?: { gpu?: GPULike } }
  return g.navigator?.gpu ?? null
}

/** Is there a WebGPU adapter at all? Cheap, async, and answered once. */
export function canCompositeWGPU(): boolean {
  return gpuOf() !== null
}

/**
 * The device, acquired once per worker. Kept out of the painter itself because
 * `adoptShape` (F13) rebuilds the painter SYNCHRONOUSLY when the arrived frames
 * disagree with the initial guess, and an async device request there would
 * either block a frame or silently leave the take with no painter.
 */
let devicePromise: Promise<GPUDeviceLike | null> | null = null
export function wgpuDevice(): Promise<GPUDeviceLike | null> {
  if (devicePromise) return devicePromise
  const gpu = gpuOf()
  if (!gpu) return (devicePromise = Promise.resolve(null))
  devicePromise = (async () => {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return null
      const device = await adapter.requestDevice()
      // WEBGPU FAILS QUIETLY. A validation error does not throw at the call
      // site — it is delivered here, asynchronously, and the frame simply does
      // not draw. Without this listener a broken pipeline is a black composite
      // with no explanation anywhere (which is exactly how the first build of
      // this file read, 2026-09-04).
      device.addEventListener?.('uncapturederror', (e) => {
        console.error('[capture] compositor: WebGPU error —', e?.error?.message ?? e)
      })
      // A lost device must not leave the take painting into nothing. The worker
      // rebuilds on the next shape change; until then the fallback below is
      // what a dead device degrades to, which is why this only clears the cache.
      device.lost
        ?.then(() => {
          console.warn('[capture] compositor: the WebGPU device was lost')
          devicePromise = null
        })
        .catch(() => {})
      return device
    } catch (err) {
      console.warn('[capture] compositor: no WebGPU device —', err)
      return null
    }
  })()
  return devicePromise
}

export interface WGPUCompositor {
  readonly canvas: OffscreenCanvas
  begin(hasScreen: boolean): void
  draw(
    source: VideoFrame,
    x: number,
    y: number,
    w: number,
    h: number,
    radiusPx: number,
    borderPx: number,
  ): void
  /**
   * Ends the frame's render pass and submits it, so the canvas can be read.
   * WebGL2 needs no equivalent — its commands are implicit — which is why the
   * worker calls this through an optional member.
   */
  end(): void
  /** Submits the frame. NOT a wait — WebGPU has no synchronous one; use
   *  `settled()` for measurement. Kept so the two painters share a shape. */
  finish(): void
  /** Resolves when the GPU has actually run everything submitted so far.
   *  Measurement only, and the counterpart of compositorGL.finish(). */
  settled(): Promise<void>
  dispose(): void
}

/**
 * Build a painter on an already-acquired device. Synchronous on purpose: see
 * `wgpuDevice` above.
 */
export function createWGPUCompositor(
  device: GPUDeviceLike,
  width: number,
  height: number,
): WGPUCompositor | null {
  const gpu = gpuOf()
  if (!gpu) return null
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContextLike | null
  if (!ctx) return null

  let pipeline: unknown
  let layout: unknown
  let sampler: unknown
  let uniforms: unknown
  const format = gpu.getPreferredCanvasFormat()
  // WEBGPU DOES NOT THROW ON A BAD SHADER. createRenderPipeline returns an
  // object that is merely invalid, and the only symptom downstream is "[Invalid
  // RenderPipeline] is invalid due to a previous error" at draw time — which is
  // how a WGSL reserved word (`in` as a parameter name) cost this file a run
  // that composited a black frame and reported it as a parity failure
  // (2026-09-04). The scope below is what makes the real message reachable.
  device.pushErrorScope('validation')
  try {
    ctx.configure({ device, format, alphaMode: 'opaque' })
    const module = device.createShaderModule({ code: SHADER })
    // A WGSL error does not throw and does not land in the validation scope
    // either — the module is simply invalid and everything built on it is
    // "invalid due to a previous error", with the actual reason reachable only
    // here. Asked for unconditionally: a shader that stops compiling in some
    // future Chrome must name itself on the console instead of turning the
    // composite black.
    module
      .getCompilationInfo?.()
      .then((info) => {
        for (const m of info.messages) {
          if (m.type === 'error') {
            console.error(`[capture] compositor: WGSL ${m.lineNum}:${m.linePos} — ${m.message}`)
          }
        }
      })
      .catch(() => null)
    layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, externalTexture: {} },
        {
          // BOTH STAGES. The vertex shader reads U.rect to place the quad and
          // the fragment shader reads U.sizePx/radius/border to shape it; a
          // fragment-only visibility here made the whole pipeline invalid and
          // every frame came out as the bare clear colour (2026-09-04).
          binding: 2,
          visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 },
        },
      ],
    })
    sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    uniforms = device.createBuffer({
      size: UNIFORM_STRIDE * UNIFORM_SLOTS,
      usage: USAGE_UNIFORM | USAGE_COPY_DST,
    })
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            // The same blend compositorGL enables, for the same reason: the PiP
            // is feathered and bordered, and it lands over the screen.
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-strip' },
    })
  } catch (err) {
    device.popErrorScope().catch(() => null)
    console.warn('[capture] compositor: WebGPU setup failed —', err)
    return null
  }
  // Asynchronous by nature: the painter is already usable, and if the scope
  // comes back with an error it says so loudly rather than painting nothing in
  // silence. The worker's fallback is what keeps the take safe either way.
  device
    .popErrorScope()
    .then((e) => {
      if (e) console.error('[capture] compositor: WebGPU pipeline is invalid —', e.message ?? e)
    })
    .catch(() => null)

  const scratch = new Float32Array(8)
  let encoder: GPUCommandEncoderLike | null = null
  let pass: GPURenderPassLike | null = null
  let slot = 0
  let disposed = false

  const flush = (): void => {
    if (!pass || !encoder) return
    pass.end()
    device.queue.submit([encoder.finish()])
    pass = null
    encoder = null
  }

  return {
    canvas,
    begin(hasScreen: boolean) {
      if (disposed) return
      // A previous frame that was never ended (a take that dropped between
      // paint and encode) must not leak its encoder into this one.
      flush()
      slot = 0
      encoder = device.createCommandEncoder()
      // Black behind a letterboxed screen, product background otherwise — the
      // same two colours layout.ts fills and compositorGL clears to.
      const c = hasScreen
        ? { r: 0, g: 0, b: 0, a: 1 }
        : { r: 0x0a / 255, g: 0x0a / 255, b: 0x0c / 255, a: 1 }
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: c,
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.setPipeline(pipeline)
    },
    draw(source, x, y, w, h, radiusPx, borderPx) {
      const p = pass
      if (!p || disposed) return
      if (slot >= UNIFORM_SLOTS) {
        console.warn('[capture] compositor: more draws in a frame than uniform slots — skipped')
        return
      }
      // Pixel rect → clip space, identical arithmetic to compositorGL: the
      // layout's origin is top-left and both APIs put clip y=+1 at the image
      // top, so y is mirrored here and the texture is flipped in the vertex
      // shader rather than by copying the frame.
      const cx = (x / width) * 2 - 1
      const cy = 1 - ((y + h) / height) * 2
      const cw = (w / width) * 2
      const ch = (h / height) * 2
      scratch[0] = cx
      scratch[1] = cy
      scratch[2] = cw
      scratch[3] = ch
      scratch[4] = w
      scratch[5] = h
      scratch[6] = radiusPx
      scratch[7] = borderPx
      const offset = slot * UNIFORM_STRIDE
      device.queue.writeBuffer(uniforms, offset, scratch)
      // THE WHOLE POINT OF THIS FILE: the frame's planes are bound where they
      // already are. No RGBA texture is created and nothing is converted into
      // one first — which is the 40-50 % of the paint the upload was costing.
      let external: unknown
      try {
        external = device.importExternalTexture({ source })
      } catch (err) {
        // A frame this device cannot import is a dropped draw, never a dead
        // take: the composite keeps its previous content for this frame and the
        // raw channels are untouched.
        console.warn('[capture] compositor: importExternalTexture refused a frame —', err)
        return
      }
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: external },
          { binding: 2, resource: { buffer: uniforms, offset: 0, size: 32 } },
        ],
      })
      p.setBindGroup(0, group, [offset])
      p.draw(4)
      slot++
    },
    end() {
      flush()
    },
    finish() {
      flush()
    },
    async settled() {
      flush()
      await device.queue.onSubmittedWorkDone()
    },
    dispose() {
      disposed = true
      flush()
    },
  }
}
