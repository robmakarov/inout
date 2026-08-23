/**
 * WebGL2 compositor backend for the capture worker (task O4 step 2).
 *
 * WHY THIS EXISTS, measured rather than assumed. The worker first composited
 * with OffscreenCanvas 2D, on the reasoning that moving off the main thread was
 * the win and the drawing backend was incidental. The A/B harness said
 * otherwise: 2D delivered 6.7 fps at 1080p against MediaRecorder's 28.8, headed
 * and headless alike — about 150 ms per frame. A capture VideoFrame lives in
 * GPU memory, and drawImage-ing it into a 2D context pulls it back across the
 * bus every single frame.
 *
 * WebGL2 uploads the frame as a texture and composites where the pixels
 * already are. The 2D path stays as the fallback for anything without WebGL2 —
 * it is slow, but slow and correct beats absent, and the watchdog will degrade
 * to MediaRecorder if even that cannot keep pace.
 *
 * The geometry here must match compose/layout.ts exactly: an unedited export
 * packet-copies this file, so a disagreement is a visible jump on the way into
 * the editor.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform vec4 u_rect;   // x, y, w, h in clip space (-1..1)
uniform int u_flipY;
void main() {
  v_uv = vec2(a_pos.x, u_flipY == 1 ? 1.0 - a_pos.y : a_pos.y);
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  gl_Position = vec4(p, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_sizePx;     // drawn size in device pixels
uniform float u_radiusPx;  // 0 = square corners
uniform float u_borderPx;  // 0 = no border

/** Signed distance to a rounded box centred on the origin. */
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

void main() {
  vec4 tex = texture(u_tex, v_uv);
  if (u_radiusPx <= 0.0 && u_borderPx <= 0.0) {
    outColor = vec4(tex.rgb, 1.0);
    return;
  }
  vec2 p = (v_uv - 0.5) * u_sizePx;
  float d = sdRoundedBox(p, u_sizePx * 0.5, u_radiusPx);
  // One pixel of feathering: the same softness the 2D clip path produced.
  float inside = 1.0 - smoothstep(-1.0, 1.0, d);
  vec3 rgb = tex.rgb;
  if (u_borderPx > 0.0) {
    float onBorder = 1.0 - smoothstep(-u_borderPx - 1.0, -u_borderPx + 1.0, d);
    // The stroke is white at 25 %, exactly as layout.ts draws it.
    rgb = mix(vec3(1.0), rgb, clamp(onBorder, 0.0, 1.0) * 0.75 + 0.25);
    rgb = mix(rgb, mix(rgb, vec3(1.0), 0.25), (1.0 - onBorder) * inside);
  }
  outColor = vec4(rgb, inside);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('compositorGL: createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`compositorGL: shader compile failed: ${log ?? 'unknown'}`)
  }
  return sh
}

export interface GLCompositor {
  readonly canvas: OffscreenCanvas
  /** Clears to the background colour for this composition. */
  begin(hasScreen: boolean): void
  /** Draws a source into a pixel rect, optionally rounded and bordered. */
  draw(
    source: VideoFrame,
    x: number,
    y: number,
    w: number,
    h: number,
    radiusPx: number,
    borderPx: number,
  ): void
  dispose(): void
}

export function createGLCompositor(width: number, height: number): GLCompositor | null {
  const canvas = new OffscreenCanvas(width, height)
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // NOT preserveDrawingBuffer: the VideoFrame is created from this canvas in
    // the same task as the draw, so the buffer is still valid — and forcing a
    // preserved buffer makes the browser copy it, which is the readback this
    // backend exists to avoid.
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null
  if (!gl) return null

  let program: WebGLProgram | null = null
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    program = gl.createProgram()
    if (!program) throw new Error('compositorGL: createProgram failed')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`compositorGL: link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
  } catch (err) {
    console.warn('[capture]', err)
    return null
  }

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uRect = gl.getUniformLocation(program, 'u_rect')
  const uSize = gl.getUniformLocation(program, 'u_sizePx')
  const uRadius = gl.getUniformLocation(program, 'u_radiusPx')
  const uBorder = gl.getUniformLocation(program, 'u_borderPx')
  const uFlip = gl.getUniformLocation(program, 'u_flipY')
  const uTex = gl.getUniformLocation(program, 'u_tex')

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  gl.useProgram(program)
  gl.uniform1i(uTex, 0)
  gl.viewport(0, 0, width, height)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  return {
    canvas,
    begin(hasScreen: boolean) {
      // Black behind a letterboxed screen, product background otherwise —
      // the same two colours layout.ts fills.
      if (hasScreen) gl.clearColor(0, 0, 0, 1)
      else gl.clearColor(0x0a / 255, 0x0a / 255, 0x0c / 255, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
    draw(source, x, y, w, h, radiusPx, borderPx) {
      gl.useProgram(program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source as unknown as TexImageSource,
      )
      // Pixel rect → clip space. GL's origin is bottom-left, the layout's is
      // top-left, so y is mirrored here and the texture is flipped in the
      // vertex shader rather than by copying the frame.
      const cx = (x / width) * 2 - 1
      const cy = 1 - ((y + h) / height) * 2
      const cw = (w / width) * 2
      const ch = (h / height) * 2
      gl.uniform4f(uRect, cx, cy, cw, ch)
      gl.uniform2f(uSize, w, h)
      gl.uniform1f(uRadius, radiusPx)
      gl.uniform1f(uBorder, borderPx)
      gl.uniform1i(uFlip, 1)
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
    dispose() {
      gl.deleteTexture(texture)
      gl.deleteBuffer(quad)
      if (program) gl.deleteProgram(program)
    },
  }
}
