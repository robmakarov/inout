#!/usr/bin/env node
/**
 * O4 STEP 1 — IS A TRANSFERRED CAPTURE VideoFrame GPU-RESIDENT IN THE WORKER,
 * OR IS EVERY `texImage2D` A READBACK?
 *
 * This is the premise the whole WebGPU task rests on, unmeasured since
 * 2026-08-24, and the gate says it is answered with a NUMBER before any backend
 * code merges. `importExternalTexture` is a zero-copy import of a GPU texture.
 * If the capture frame is already GPU-resident, WebGL's upload is a GPU→GPU
 * copy plus a colour conversion and WebGPU deletes it — that is the 4K win. If
 * the frame lives in CPU memory, BOTH backends must upload it, WebGPU deletes
 * nothing, and O4 is worth only the 2 % the draw costs.
 *
 * THE INSTRUMENT, and every part of it exists because a timing number alone
 * could not carry this verdict (note 10 — the rig is wrong before the product):
 *
 *   TWO INDEPENDENT DISCRIMINATORS, not one. `texImage2D` and `copyTo` fail in
 *   OPPOSITE directions, so they cannot both be fooled by the same artefact:
 *
 *                     upload (texImage2D+fence)   copyTo (definitional readback)
 *     GPU-resident    cheap  (blit)               EXPENSIVE (reads back)
 *     CPU-resident    EXPENSIVE (uploads)         cheap (memcpy)
 *
 *   TWO CONTROLS OF KNOWN RESIDENCY, at the same size and — for the CPU one —
 *   the same pixel format the capturer actually delivers (NV12):
 *     gpu-control   `new VideoFrame(<webgl2 OffscreenCanvas>)`, unambiguously
 *                   a GPU texture
 *     cpu-control   `new VideoFrame(<ArrayBuffer>, {format:'NV12'})`,
 *                   unambiguously CPU bytes
 *   A capture lane that lands on the cpu-control's numbers is CPU-resident. One
 *   that lands on the gpu-control's is GPU-resident. Reading the capture lane
 *   without both controls would be reading a number with no scale.
 *
 *   A SYNCHRONISATION POINT THAT ACTUALLY WAITS, and a lever that proves it.
 *   `gl.finish()` does NOT wait here: with it, a shader doing 64 texture
 *   fetches per pixel over 5.9 Mpx cost the same 0.03 ms as one doing 16
 *   (measured 2026-09-04). So the sync is a one-pixel `readPixels`, whose
 *   returned byte cannot exist before the pipeline has run, and `heavy16` /
 *   `heavy64` stay in the rotation as the standing proof: 4x the per-fragment
 *   work must cost about 4x, or nothing in this file is timing the GPU and the
 *   verdict is void.
 *
 *   AN INSTRUMENT FLOOR, subtracted from nothing but reported beside
 *   everything: `fenceFloor` is that same readPixels on an empty command
 *   buffer. A probe near the floor is reported as at-the-floor, never as zero.
 *
 *   THE DRAW SEPARATED FROM THE UPLOAD. `uploadTiny` draws the frame into a
 *   64x64 viewport: same upload, ~no fill. If cost tracks source pixels while
 *   the destination is tiny, the cost is the upload and not the shading.
 *
 *   A SECOND UPLOAD OF THE SAME FRAME (`uploadTwice`). If Chrome converts once
 *   and caches a GPU copy, the second upload is free and the first number means
 *   something different — so it is measured rather than assumed either way.
 *
 *   REAL CAPTURERS, and more than one of them. `display` is production's shape
 *   (getDisplayMedia → MediaStreamTrackProcessor on the main thread → the frame
 *   TRANSFERRED to a worker). `tab` and `camera` are different capturers inside
 *   Chrome and may differ. `canvas` is what every synthetic rig in this repo
 *   uses — if it does not agree with `display`, every composite number ever
 *   taken through `?synthetic=1` is measuring a different pixel path, and that
 *   is a finding in its own right.
 *
 * The page is served from this script (127.0.0.1 is a secure context) with
 * COOP/COEP so `performance.now()` in the worker is 5 µs rather than
 * coarsened to 100 µs. Nothing here touches product code.
 *
 *   node scripts/gpu-residency.mjs
 *   node scripts/gpu-residency.mjs --lanes=display,controls --frames=60
 *   node scripts/gpu-residency.mjs --camera --json
 *
 * Headed by default and it must stay that way: the canvas lane is painted from
 * requestAnimationFrame, and a hidden or headless window does not run it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'
import { loadLine, startLoadSampler, waitForQuiet } from './lib/machine.mjs'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}
const OPTS = {
  lanes: String(flag('lanes', 'display,display1080,tab,canvas,canvas4k,controls')).split(',').filter(Boolean),
  frames: Number(flag('frames', 48)),
  camera: flag('camera', false) === true,
  headless: flag('headless', false) === true,
  json: flag('json', false) === true,
  keep: flag('keep', false) === true,
}
if (OPTS.camera && !OPTS.lanes.includes('camera')) OPTS.lanes.push('camera')

/* ------------------------------------------------------------------ page --- */

/** The measuring worker. One probe per frame, rotated, so no probe ever pays
 *  for the one before it — a frame that was just uploaded is warm, and a
 *  back-to-back probe pair would measure that warmth instead of the frame. */
const WORKER_JS = String.raw`
let gl = null, glW = 0, glH = 0, program = null, quad = null, uRect = null, uFlip = null
let heavy = null, hRect = null, hFlip = null, hIters = null
let ctrlGl = null, ctrlCanvas = null, ctrlW = 0, ctrlH = 0

const VERT = '#version 300 es\n' +
  'in vec2 a_pos; out vec2 v_uv; uniform vec4 u_rect; uniform int u_flipY;\n' +
  'void main(){ v_uv = vec2(a_pos.x, u_flipY==1 ? 1.0-a_pos.y : a_pos.y);\n' +
  ' vec2 p = u_rect.xy + a_pos * u_rect.zw; gl_Position = vec4(p,0.0,1.0); }'
const FRAG = '#version 300 es\nprecision highp float;\n' +
  'in vec2 v_uv; out vec4 outColor; uniform sampler2D u_tex;\n' +
  'void main(){ outColor = vec4(texture(u_tex, v_uv).rgb, 1.0); }'
/** THE FENCE'S OWN LEVER. Apple's GPU is tile-based and deferred: 64 identical
 *  opaque fullscreen quads are hidden-surface-removed down to one, so drawing
 *  the same thing N times measured 0.00 ms/draw and tested nothing (measured
 *  2026-09-04, first attempt). Per-fragment work cannot be removed that way, so
 *  the lever is a LOOP inside the shader, run at two counts. If gl.finish()
 *  really waits, the 4x loop must cost ~4x. If it does not, nothing in this rig
 *  is timing the GPU and every number here is void. */
const FRAG_HEAVY = '#version 300 es\nprecision highp float;\n' +
  'in vec2 v_uv; out vec4 outColor; uniform sampler2D u_tex; uniform int u_iters;\n' +
  'void main(){ vec3 a = vec3(0.0);\n' +
  ' for (int i = 0; i < u_iters; i++) { float f = float(i) * 0.00137;\n' +
  '  a += texture(u_tex, fract(v_uv + vec2(f, f * 0.5))).rgb; }\n' +
  ' outColor = vec4(a / float(u_iters), 1.0); }'

function compile(g, type, src) {
  const sh = g.createShader(type); g.shaderSource(sh, src); g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error('compile: ' + g.getShaderInfoLog(sh))
  return sh
}

/** The measuring context. Same options compositorGL.ts ships with, because a
 *  different context is a different answer. */
function ensureGL(w, h) {
  if (gl && glW === w && glH === h) return gl
  const canvas = new OffscreenCanvas(w, h)
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
  if (!gl) throw new Error('no webgl2 in worker')
  glW = w; glH = h
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  program = gl.createProgram()
  gl.attachShader(program, vs); gl.attachShader(program, fs)
  // Slot 0 in BOTH programs, explicitly. The quad's vertexAttribPointer is set
  // up once; if the heavy program's a_pos landed on a different index the draw
  // would read garbage, rasterise nothing and cost nothing — which is
  // indistinguishable from a fence that does not wait.
  gl.bindAttribLocation(program, 0, 'a_pos')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(program))
  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,1,0,0,1,1,1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  uRect = gl.getUniformLocation(program, 'u_rect')
  uFlip = gl.getUniformLocation(program, 'u_flipY')
  const fsH = compile(gl, gl.FRAGMENT_SHADER, FRAG_HEAVY)
  heavy = gl.createProgram()
  gl.attachShader(heavy, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(heavy, fsH)
  gl.bindAttribLocation(heavy, 0, 'a_pos')
  gl.linkProgram(heavy)
  if (!gl.getProgramParameter(heavy, gl.LINK_STATUS)) throw new Error('link heavy: ' + gl.getProgramInfoLog(heavy))
  hRect = gl.getUniformLocation(heavy, 'u_rect')
  hFlip = gl.getUniformLocation(heavy, 'u_flipY')
  hIters = gl.getUniformLocation(heavy, 'u_iters')
  gl.useProgram(heavy)
  gl.uniform1i(gl.getUniformLocation(heavy, 'u_tex'), 0)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.useProgram(program)
  gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0)
  gl.activeTexture(gl.TEXTURE0)
  return gl
}

/**
 * THE SYNCHRONISATION POINT, and it is not gl.finish().
 *
 * Measured 2026-09-04: with gl.finish() alone a fragment shader doing 64
 * texture fetches per pixel over 5.9 Mpx cost the same 0.03 ms as one doing 16
 * — i.e. 12 tera-fetches per second, i.e. finish() returned before the GPU had
 * done the work. readPixels cannot: the byte it returns has to exist, so the
 * pipeline is flushed and waited on. It costs a one-pixel readback, and the
 * fenceFloor probe measures exactly that and reports it beside every number.
 */
const onePx = new Uint8Array(4)
function sync() {
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePx)
}

function upload(frame) {
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
}
function drawFull(w, h) {
  gl.viewport(0, 0, w, h)
  gl.uniform4f(uRect, -1, -1, 2, 2)
  gl.uniform1i(uFlip, 1)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}
function drawHeavy(w, h, iters) {
  gl.useProgram(heavy)
  gl.viewport(0, 0, w, h)
  gl.uniform4f(hRect, -1, -1, 2, 2)
  gl.uniform1i(hFlip, 1)
  gl.uniform1i(hIters, iters)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  gl.useProgram(program)
}
function drawTiny() {
  gl.viewport(0, 0, 64, 64)
  gl.uniform4f(uRect, -1, -1, 2, 2)
  gl.uniform1i(uFlip, 1)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

/** A GPU-resident frame of known provenance: rendered by a SECOND webgl2
 *  context, then wrapped. Second context deliberately — a frame made from the
 *  very canvas we upload into could take a fast path a transferred frame never
 *  gets, and that would flatter the control. */
function gpuControlFrame(w, h, ts) {
  if (!ctrlGl || ctrlW !== w || ctrlH !== h) {
    ctrlCanvas = new OffscreenCanvas(w, h)
    ctrlGl = ctrlCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false })
    ctrlW = w; ctrlH = h
  }
  // Repaint every time: a static canvas may hand back the same shared image.
  const t = (ts % 1000) / 1000
  ctrlGl.viewport(0, 0, w, h)
  ctrlGl.clearColor(t, 1 - t, 0.5, 1)
  ctrlGl.clear(ctrlGl.COLOR_BUFFER_BIT)
  ctrlGl.flush()
  return new VideoFrame(ctrlCanvas, { timestamp: ts, duration: 16666 })
}

/** CPU bytes, in the format the capturer actually delivers. */
let nv12Buf = null
function cpuControlFrame(w, h, ts) {
  const need = w * h + (w * h) / 2
  if (!nv12Buf || nv12Buf.length !== need) {
    nv12Buf = new Uint8Array(need)
    for (let i = 0; i < need; i++) nv12Buf[i] = (i * 37) & 0xff
  }
  nv12Buf[ts % (w * h)] = ts & 0xff  // never the identical buffer twice
  return new VideoFrame(nv12Buf, { format: 'NV12', codedWidth: w, codedHeight: h, timestamp: ts, duration: 16666 })
}

const PROBES = ['fenceFloor', 'enqueue', 'drawOnly', 'upload', 'uploadSame', 'full', 'copyTo', 'heavy16', 'heavy64']
const BATCH = 24
/**
 * HOW MANY FRAMES A LANE MAY HOLD. A real capturer's IOSurface pool is small:
 * holding six live display frames starved getDisplayMedia down to TWO frames
 * for a whole lane (measured 2026-09-04). So a real lane holds ONE, and the
 * controls — which cost nothing to hold — run a ring of six and carry the proof
 * that this is fair: on both controls the uploadSame probe (one frame, 24
 * times) lands on the upload probe (six frames round-robin) to within noise:
 * Chrome caches no converted texture per frame, so a repeat is not free.
 */
const ringSize = (lane) => (lane === 'gpu-control' || lane === 'cpu-control' ? 6 : 1)

/**
 * ONE SYNC PER BATCH, NOT PER OPERATION. readPixels really does wait, but it
 * costs 2-4 ms of its own once the pipeline has work in it (measured
 * 2026-09-04), which is larger than every difference this rig exists to see.
 * Twenty-four operations behind one sync amortise that to ~0.1 ms and leave the
 * GPU work itself, which is what the final sync still waits for.
 *
 * The batch walks a RING of recent frames rather than repeating one, because
 * "upload the same frame 24 times" is a question about Chrome caching a
 * converted texture, not about where the pixels live. That question gets its
 * own probe (uploadSame) so both answers are on the table.
 */
const rings = new Map()
function ringFor(lane, w, h) {
  const k = lane + '|' + w + 'x' + h
  if (!rings.has(k)) rings.set(k, [])
  return rings.get(k)
}
function pushRing(lane, w, h, frame) {
  const r = ringFor(lane, w, h)
  r.push(frame)
  while (r.length > ringSize(lane)) r.shift().close()
}
function clearRings() {
  for (const r of rings.values()) for (const f of r) { try { f.close() } catch (e) {} }
  rings.clear()
}

function batch(fn, frames) {
  const t0 = performance.now()
  for (let i = 0; i < BATCH; i++) fn(frames[i % frames.length])
  sync()
  return (performance.now() - t0) / BATCH
}

async function measure(probe, frames, w, h) {
  ensureGL(w, h)
  const one = frames[frames.length - 1]
  if (probe === 'fenceFloor') {
    // The instrument's own cost: the sync on an empty command buffer.
    const t0 = performance.now(); sync(); return performance.now() - t0
  }
  if (probe === 'enqueue') {
    // TODAY'S paintMs SHAPE: the JS calls only, nothing waited on. Reported so
    // the gap between what the product measures and what it costs is visible.
    const t0 = performance.now(); upload(one); drawFull(w, h); return performance.now() - t0
  }
  if (probe === 'drawOnly') return batch(() => drawFull(w, h), frames)
  if (probe === 'upload') return batch((f) => upload(f), frames)
  if (probe === 'uploadSame') return batch(() => upload(one), [one])
  if (probe === 'full') return batch((f) => { upload(f); drawFull(w, h) }, frames)
  if (probe === 'heavy16') return batch((f) => { upload(f); drawHeavy(w, h, 16) }, frames)
  if (probe === 'heavy64') return batch((f) => { upload(f); drawHeavy(w, h, 64) }, frames)
  if (probe === 'copyTo') {
    // Not batched and it does not need to be: copyTo resolves when the copy is
    // done, so it never depended on the fence at all.
    const size = one.allocationSize()
    const buf = new ArrayBuffer(size)
    const t0 = performance.now()
    await one.copyTo(buf)
    return performance.now() - t0
  }
  return NaN
}

const acc = new Map()   // key: lane|w x h|probe -> number[]
const meta = new Map()  // key: lane|w x h -> {format, ...}
function note(lane, w, h, probe, ms) {
  const k = lane + '|' + w + 'x' + h + '|' + probe
  if (!acc.has(k)) acc.set(k, [])
  acc.get(k).push(ms)
}

let rot = 0
async function handleFrame(lane, frame) {
  const w = frame.displayWidth, h = frame.displayHeight
  const mk = lane + '|' + w + 'x' + h
  if (!meta.has(mk)) {
    meta.set(mk, {
      format: frame.format ? String(frame.format) : null,
      codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      allocationSize: (() => { try { return frame.allocationSize() } catch (e) { return null } })(),
    })
  }
  pushRing(lane, w, h, frame)
  const frames = ringFor(lane, w, h)
  // The ring has to be full before a batch means anything.
  if (frames.length < ringSize(lane)) return
  const probe = PROBES[rot++ % PROBES.length]
  let ms = NaN
  try { ms = await measure(probe, frames, w, h) } catch (e) { /* reported as missing */ }
  if (Number.isFinite(ms)) note(lane, w, h, probe, ms)
}

self.onmessage = async (ev) => {
  const m = ev.data
  if (m.cmd === 'frame') { await handleFrame(m.lane, m.frame); self.postMessage({ done: m.seq }); return }
  if (m.cmd === 'laneDone') { clearRings(); self.postMessage({ laneDone: true }); return }
  if (m.cmd === 'controls') {
    for (const [w, h] of m.sizes) {
      for (const lane of ['gpu-control', 'cpu-control']) {
        for (let i = 0; i < m.frames * PROBES.length; i++) {
          let f = null
          try { f = lane === 'gpu-control' ? gpuControlFrame(w, h, i * 16666 + 1) : cpuControlFrame(w, h, i * 16666 + 1) }
          catch (e) { break }
          await handleFrame(lane, f)
        }
        clearRings()
      }
      // Between sizes: let the GPU settle so the next size does not inherit it.
      await new Promise((r) => setTimeout(r, 150))
    }
    self.postMessage({ controlsDone: true })
    return
  }
  if (m.cmd === 'report') {
    const out = { cells: [], meta: Object.fromEntries(meta) }
    for (const [k, arr] of acc) {
      const [lane, size, probe] = k.split('|')
      const s = arr.slice().sort((a, b) => a - b)
      out.cells.push({
        lane, size, probe, n: s.length,
        p50: s[Math.floor(s.length / 2)],
        p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))],
        mean: s.reduce((a, b) => a + b, 0) / s.length,
        min: s[0], max: s[s.length - 1],
      })
    }
    self.postMessage({ report: out })
    return
  }
}
`

const PAGE_HTML = String.raw`<!doctype html><meta charset=utf-8>
<title>O4 step 1 — GPU residency</title>
<style>html,body{margin:0;background:#111;color:#ddd;font:13px ui-monospace,monospace}
#rig{position:fixed;inset:0;width:100%;height:100%}#log{position:fixed;left:8px;top:8px;z-index:2;white-space:pre}</style>
<canvas id=rig></canvas><div id=log>starting…</div>
<script id=worker type=text/plain>__WORKER__</script>
<script>
const log = (s) => { document.getElementById('log').textContent = s }
const workerSrc = document.getElementById('worker').textContent
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })))
const waiters = new Map()
let seq = 0
worker.onmessage = (ev) => {
  const m = ev.data
  const key = m.done !== undefined ? 'f' + m.done : m.controlsDone ? 'controls'
    : m.laneDone ? 'laneDone' : m.report ? 'report' : null
  if (key && waiters.has(key)) { const w = waiters.get(key); waiters.delete(key); w(m) }
}
const wait = (key) => new Promise((r) => waiters.set(key, r))

/** The synthetic source every rig in this repo uses: an accelerated 2D canvas
 *  repainted from rAF and handed over with captureStream. */
function canvasStream(w, h, fps) {
  const c = document.getElementById('rig')
  c.width = w; c.height = h
  const g = c.getContext('2d')
  let n = 0
  ;(function paint() { n++
    g.fillStyle = 'hsl(' + (n * 7 % 360) + ',70%,45%)'; g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'; g.fillRect((n * 13) % Math.max(1, w - 200), (n * 7) % Math.max(1, h - 200), 200, 200)
    requestAnimationFrame(paint) })()
  return c.captureStream(fps)
}

async function laneStream(lane) {
  if (lane === 'display') {
    // A screen capturer emits on CHANGE too. Against a still desktop the capped
    // row delivered ONE frame and read empty (measured 2026-09-04) — so the rig
    // window is given something small that moves. 480x270 of a 1512x982 logical
    // screen: enough to keep the capturer emitting, far too little to be the
    // GPU load the numbers are about.
    canvasStream(480, 270, 60)
    await new Promise((r) => setTimeout(r, 300))
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { ideal: 4096 }, height: { ideal: 4096 } }, audio: false })
  }
  if (lane === 'display1080') {
    // THE SHIPPED SHAPE: capDisplayTrack pins a display track to 1080p before
    // any consumer exists, so this is the row every O4 decision is about.
    // Asked for at acquire time rather than by applyConstraints on a live
    // track: re-constraining dropped the capturer to 30 fps resizeMode:none and
    // it then delivered ONE frame against a near-still desktop (2026-09-04).
    canvasStream(480, 270, 60)
    await new Promise((r) => setTimeout(r, 300))
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false })
  }
  if (lane === 'tab') {
    // A tab capturer emits on CHANGE. Against this rig's own static page it
    // delivered 0-1 frames per size and the lane measured nothing (2026-09-04),
    // so the page is given something that moves before the capture is asked
    // for — small, so it is not itself the GPU load being measured.
    canvasStream(480, 270, 60)
    await new Promise((r) => setTimeout(r, 300))
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } }, audio: false, preferCurrentTab: true })
  }
  if (lane === 'camera') return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false })
  if (lane === 'canvas') return canvasStream(1920, 1080, 60)
  // THE SHAPE THE 35.6 ms CAME FROM (o4step2, 2026-08-24): an uncapped 4K
  // canvas fed straight into the composite. Re-priced here beside a real
  // capturer instead of standing in for one.
  if (lane === 'canvas4k') return canvasStream(3840, 2160, 60)
  throw new Error('unknown lane ' + lane)
}

/** PRODUCTION'S SHAPE, deliberately: the reader runs on the MAIN thread and the
 *  frame is TRANSFERRED (liveCompositeV2.ts:835). Reading inside the worker
 *  would be a different pixel path and would answer a question nobody asked. */
function openReader(track) {
  const TP = self.MediaStreamTrackProcessor
  return new TP({ track }).readable.getReader()
}

/** PRODUCTION'S SHAPE, deliberately: the reader runs on the MAIN thread and the
 *  frame is TRANSFERRED (liveCompositeV2.ts:835). Reading inside the worker
 *  would be a different pixel path and would answer a question nobody asked.
 *
 *  The reader is passed IN rather than opened here, because the capped lane
 *  reads the SAME track after applyConstraints: cancelling a track processor's
 *  stream and opening a second one on the same track delivered zero frames
 *  (measured 2026-09-04), so the capped row read empty and looked like a
 *  capture failure. */
async function pump(lane, reader, budgetFrames, deadlineMs) {
  const until = performance.now() + deadlineMs
  let got = 0
  while (got < budgetFrames && performance.now() < until) {
    const r = await Promise.race([
      reader.read(),
      new Promise((res) => setTimeout(() => res({ done: true, stalled: true }), 8000)),
    ])
    const { value, done } = r
    if (done || !value) break
    const s = seq++
    const p = wait('f' + s)
    worker.postMessage({ cmd: 'frame', lane, seq: s, frame: value }, [value])
    await p
    got++
  }
  return got
}

window.__run = async (opts) => {
  const out = { lanes: {}, errors: [], sizes: [] }
  for (const lane of opts.lanes) {
    if (lane === 'controls') continue
    log('lane ' + lane + '…')
    let stream = null
    try {
      // BOUNDED. A picker that never answers is the wedge's own signature
      // (docs/SCREEN_WEDGE.md) and must fail this lane loudly rather than eat
      // the whole run's budget in silence.
      stream = await Promise.race([
        laneStream(lane),
        new Promise((_, rej) => setTimeout(() => rej(new Error('stream never arrived in 25s')), 25000)),
      ])
      const track = stream.getVideoTracks()[0]
      const s0 = track.getSettings()
      const budget = opts.frames * 9 + 6   // one full probe rotation per frame
      const reader = openReader(track)
      const got = await pump(lane, reader, budget, 40000)
      const s1 = track.getSettings()
      out.lanes[lane] = { settings: s1, asked: s0, frames: got }
      if (s1.width && s1.height) out.sizes.push([s1.width, s1.height])
      try { await reader.cancel() } catch (e) {}
      track.stop()
      const ld = wait('laneDone')
      worker.postMessage({ cmd: 'laneDone' })
      await ld
    } catch (e) {
      out.errors.push(lane + ': ' + (e && e.message ? e.message : String(e)))
    } finally {
      if (stream) for (const t of stream.getTracks()) t.stop()
    }
  }
  if (opts.lanes.includes('controls')) {
    log('controls…')
    // Every size a real lane produced, plus the three the task quotes against.
    const want = new Map()
    for (const [w, h] of out.sizes) want.set(w + 'x' + h, [w, h])
    for (const [w, h] of [[1920, 1080], [3024, 1964], [3840, 2160]]) want.set(w + 'x' + h, [w, h])
    const sizes = [...want.values()]
    const p = wait('controls')
    worker.postMessage({ cmd: 'controls', sizes, frames: Math.max(6, Math.round(opts.frames / 4)) })
    await p
    out.controlSizes = sizes
  }
  const rp = wait('report')
  worker.postMessage({ cmd: 'report' })
  out.report = (await rp).report
  out.gpu = (() => {
    try {
      const c = document.createElement('canvas').getContext('webgl2')
      const d = c.getExtension('WEBGL_debug_renderer_info')
      return { renderer: d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER),
               vendor: d ? c.getParameter(d.UNMASKED_VENDOR_WEBGL) : c.getParameter(c.VENDOR) }
    } catch (e) { return null }
  })()
  out.isolated = self.crossOriginIsolated === true
  out.dpr = devicePixelRatio
  log('done')
  return JSON.stringify(out)
}
</script>`

/* ------------------------------------------------------------------ run --- */

function serve() {
  const html = PAGE_HTML.replace('__WORKER__', WORKER_JS)
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 5 µs performance.now() in the worker instead of a 100 µs coarsening —
      // the difference between measuring a 0.2 ms probe and quantising it.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')

function table(report, meta) {
  const probes = ['fenceFloor', 'enqueue', 'drawOnly', 'upload', 'uploadSame', 'full', 'copyTo', 'heavy16', 'heavy64']
  const keys = [...new Set(report.cells.map((c) => `${c.lane}|${c.size}`))]
  const rows = []
  for (const k of keys) {
    const [lane, size] = k.split('|')
    const cell = (p) => report.cells.find((c) => c.lane === lane && c.size === size && c.probe === p)
    const px = size.split('x').reduce((a, b) => a * Number(b), 1)
    // THE FRAME'S OWN BYTES, not a nominal pixel count. NV12 is 1.5 bytes per
    // pixel and BGRA is 4, so a rate computed from pixels would call the canvas
    // lane 2.7x faster than it is and the whole verdict would turn on the
    // format rather than on where the pixels live.
    const bytes = meta[k]?.allocationSize ?? px * 1.5
    const row = { lane, size, mpx: px / 1e6, bytes, n: cell('upload')?.n ?? 0 }
    for (const p of probes) row[p] = cell(p)?.p50
    row.uploadMBs = row.upload ? bytes / 1e6 / (row.upload / 1000) : NaN
    row.copyMBs = row.copyTo ? bytes / 1e6 / (row.copyTo / 1000) : NaN
    rows.push(row)
  }
  rows.sort((a, b) => (a.lane === b.lane ? a.mpx - b.mpx : a.lane.localeCompare(b.lane)))
  const head =
    'lane'.padEnd(13) + 'size'.padEnd(11) + 'MB'.padStart(6) + 'n'.padStart(4) + '  ' +
    probes.map((p) => p.padStart(11)).join('') + 'up MB/s'.padStart(10) + 'copy MB/s'.padStart(11)
  const lines = [head, '-'.repeat(head.length)]
  for (const r of rows) {
    lines.push(
      r.lane.padEnd(13) + r.size.padEnd(11) + (r.bytes / 1e6).toFixed(1).padStart(6) +
      String(r.n).padStart(4) + '  ' +
      probes.map((p) => fmt(r[p]).padStart(11)).join('') +
      fmt(r.uploadMBs, 0).padStart(10) + fmt(r.copyMBs, 0).padStart(11),
    )
  }
  return { text: lines.join('\n'), rows }
}

/**
 * THE VERDICT, and it rests on an INEQUALITY rather than on a position between
 * two controls.
 *
 * The task's question is binary — GPU-resident or read back — and on Apple
 * Silicon that binary does not exist: a capture frame is an IOSurface in
 * unified memory, which the GPU can texture from AND the CPU can map. Placing
 * it "between" two controls therefore reads mixed no matter how the scale is
 * drawn, and a mixed reading answers nothing.
 *
 * What the task actually needs to know is whether the upload is a READBACK, and
 * that has a decisive form that needs no calibration at all:
 *
 *     a readback followed by an upload can never be CHEAPER than uploading the
 *     same bytes, in the same format, at the same size, straight from CPU
 *     memory — that is the same upload with a readback added in front.
 *
 * So the test is one comparison against `cpu-control`, which is exactly those
 * same bytes in that same format at that same size through that same call.
 * Below it: not a readback, and there is GPU headroom for importExternalTexture
 * to reclaim. At or above it: the upload is at best a plain CPU upload and
 * WebGPU has nothing to remove.
 *
 * `copyTo` stays, but it is reported as a separate FACT rather than as a second
 * vote: how fast the CPU can map the same frame. On unified memory both can be
 * true at once, and pretending they must agree is what made this read DISAGREE.
 */
function verdict(rows) {
  const at = (lane, size) => rows.find((r) => r.lane === lane && r.size === size)
  const out = []
  for (const r of rows) {
    if (r.lane === 'gpu-control' || r.lane === 'cpu-control') continue
    const c = at('cpu-control', r.size)
    const g = at('gpu-control', r.size)
    if (!c || !r.upload || !c.upload) continue
    const ratio = r.upload / c.upload
    out.push({
      lane: r.lane, size: r.size, bytesMB: r.bytes / 1e6, mpx: r.mpx, n: r.n,
      upload: r.upload, cpuUpload: c.upload, gpuUpload: g?.upload ?? null,
      ratio,
      // The margin is deliberately wide: anything within 20 % of a plain CPU
      // upload is called NOT-CHEAPER rather than "slightly better", because a
      // 20 % edge is not worth a third rendering backend.
      says: ratio < 0.8 ? 'NOT A READBACK' : ratio > 1.2 ? 'READBACK OR WORSE' : 'no cheaper than a CPU upload',
      copyTo: r.copyTo, cpuCopyTo: c.copyTo, gpuCopyTo: g?.copyTo ?? null,
      copyRatio: r.copyTo && c.copyTo ? r.copyTo / c.copyTo : NaN,
      paintPerMpx: r.full ? r.full / r.mpx : NaN,
      uploadShare: r.full ? r.upload / r.full : NaN,
    })
  }
  return out
}

/** Does the instrument's own fence still wait? heavy64 must cost clearly more
 *  than heavy16 or nothing here is timing the GPU. */
function fenceCheck(rows) {
  const out = []
  for (const r of rows) {
    if (!r.heavy16 || !r.heavy64) continue
    out.push({ lane: r.lane, size: r.size, heavy16: r.heavy16, heavy64: r.heavy64, ratio: r.heavy64 / r.heavy16 })
  }
  const median = out.length ? out.map((x) => x.ratio).sort((a, b) => a - b)[Math.floor(out.length / 2)] : NaN
  return { rows: out, median, ok: median >= 1.5 }
}

async function main() {
  const bin = resolveChrome()
  if (!bin) { console.error('gpu-residency: no Chrome found'); process.exit(2) }
  const { server, port } = await serve()
  const url = `http://127.0.0.1:${port}/`
  const profile = mkdtempSync(join(tmpdir(), 'inout-o4res-'))
  const extraArgs = [
    // Chrome's own picker automation. Without these getDisplayMedia opens a
    // dialog nothing can answer. The macOS system picker (ScreenCaptureKit) is
    // a native window no switch can reach, so Chrome's in-content picker is put
    // back — the same three features fps-check.mjs disables, for the same
    // reason and with the same measured signature if they are left on.
    `--auto-select-desktop-capture-source=${process.env.INOUT_CAPTURE_SOURCE ?? 'Entire screen'}`,
    '--auto-accept-this-tab-capture',
    // launchChrome() already passes a --disable-features; Chrome keeps the LAST
    // occurrence of a repeated switch, so its value is carried here rather than
    // silently dropped.
    '--disable-features=InfiniteSessionRestore,' + (process.env.INOUT_CAPTURE_DISABLE ??
      'ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'),
    // NOT --use-fake-ui-for-media-stream. It auto-answers getDisplayMedia with
    // no source selected, and the display and tab lanes both died on
    // "Could not start video source" (measured 2026-09-04) while the picker
    // switches above were being blamed. The camera lane gets its permission
    // through CDP instead, which grants without answering the picker.
    '--window-size=1280,860',
  ]
  // G6's rule: a bounded quiet preflight, and the load printed beside every
  // number so a reading taken under a busy machine says so rather than lying.
  const pre = await waitForQuiet({ label: 'gpu-residency', maxWaitMs: 45_000 })
  const sampler = startLoadSampler()
  let session = null
  let result = null
  let load = null
  try {
    // viaOpen: a node-spawned Chrome is denied macOS Screen Recording (TCC
    // attributes to the responsible process), and the display lane is the whole
    // point of this rig. See lib/chrome.mjs.
    session = await launchChromeRetrying({
      bin, profile, url, headed: !OPTS.headless, extraArgs,
      viaOpen: process.platform === 'darwin' && OPTS.lanes.some((l) => l.startsWith('display')),
    })
    try {
      await session.send('Browser.grantPermissions', { origin: url, permissions: ['videoCapture'] })
    } catch (e) { /* camera lane will say so */ }
    await sleep(1200)
    const raw = await session.evaluate(
      `window.__run(${JSON.stringify({ lanes: OPTS.lanes, frames: OPTS.frames })})`,
      330_000,
    )
    result = typeof raw === 'string' ? JSON.parse(raw) : raw
  } finally {
    load = sampler.stop()
    if (session && !OPTS.keep) await quitChrome(session)
    server.close()
    if (!OPTS.keep) rmSync(profile, { recursive: true, force: true })
  }

  const t = table(result.report, result.report.meta)
  const v = verdict(t.rows)
  const payload = {
    load: { preflight: pre, during: load, line: loadLine(load) },
    gpu: result.gpu,
    crossOriginIsolated: result.isolated,
    devicePixelRatio: result.dpr,
    lanes: result.lanes,
    errors: result.errors,
    meta: result.report.meta,
    cells: result.report.cells,
    verdict: v,
  }
  if (OPTS.json) { console.log(JSON.stringify(payload, null, 2)); return }

  console.log('\nO4 STEP 1 — GPU RESIDENCY OF A TRANSFERRED CAPTURE FRAME')
  console.log(`${loadLine(load)} · preflight ${(pre.busy * 100).toFixed(0)}% ${pre.quiet ? 'quiet' : 'NOT QUIET'}`)
  console.log(`gpu: ${result.gpu?.renderer ?? '?'}  ·  crossOriginIsolated=${result.isolated} (timer ${result.isolated ? '5 µs' : '100 µs — COARSENED'})  ·  dpr=${result.dpr}`)
  for (const [lane, info] of Object.entries(result.lanes)) {
    const s = info.settings ?? {}
    console.log(`lane ${lane}: ${s.width}x${s.height}@${s.frameRate ?? '?'} · ${info.frames} frames` +
      (info.capped ? ` · capped ${info.capped.settings.width}x${info.capped.settings.height} · ${info.capped.frames} frames` : ''))
  }
  for (const [k, m] of Object.entries(result.report.meta)) {
    console.log(`  format ${k.padEnd(26)} = ${m.format ?? 'null (opaque)'}  coded ${m.codedWidth}x${m.codedHeight}  alloc ${m.allocationSize ?? '—'}`)
  }
  if (result.errors.length) console.log('errors: ' + result.errors.join(' | '))
  console.log('\np50 ms per frame (fenceFloor = the instrument itself; subtract nothing, read against it)\n')
  console.log(t.text)
  const fc = fenceCheck(t.rows)
  console.log(`\nINSTRUMENT: heavy64/heavy16 median ${fmt(fc.median)}x — the readPixels sync ${fc.ok ? 'WAITS for the GPU (numbers stand)' : 'DOES NOT WAIT (every number above is void)'}`)

  console.log('\nVERDICT — is the upload a READBACK?')
  console.log('  A readback + upload cannot be cheaper than uploading the same bytes, same')
  console.log('  format, same size straight from CPU memory. cpu-control IS that upload.\n')
  for (const r of v) {
    const pad = ' '.repeat(11)
    console.log(
      `  ${r.lane.padEnd(9)} ${r.size.padEnd(11)} ${r.bytesMB.toFixed(1)} MB/frame, n=${r.n}` +
      `\n  ${pad}upload ${fmt(r.upload)} ms vs the same bytes from CPU ${fmt(r.cpuUpload)} ms = ${fmt(r.ratio)}x  -> ${r.says}` +
      `\n  ${pad}copyTo ${fmt(r.copyTo)} ms vs CPU-resident ${fmt(r.cpuCopyTo)} ms = ${fmt(r.copyRatio)}x  (how fast the CPU can map it; a fact, not a vote)` +
      `\n  ${pad}paint (upload+full draw) ${fmt(r.paintPerMpx, 3)} ms/Mpx · the upload is ${fmt(r.uploadShare * 100, 0)}% of it` +
      `\n  ${pad}=> 4K (8.29 Mpx) projects to ${fmt(r.paintPerMpx * 8.29)} ms/frame\n`)
  }
  payload.fence = fc

  const dump = join(process.cwd(), 'docs/qa/o4-gpu-residency.json')
  try { writeFileSync(dump, JSON.stringify(payload, null, 2)) ; console.log(`json: ${dump}`) } catch (e) {}
}

main().catch((e) => { console.error(e); process.exit(1) })
