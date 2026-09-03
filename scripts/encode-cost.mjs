#!/usr/bin/env node
/**
 * HOW FAST CAN THIS MACHINE ENCODE ONE EXPORTED FRAME — the gate for the
 * "rendering is fucking too slow" report (Robert 2026-09-02, a 124-minute take
 * that took over an hour).
 *
 * R2's rig (`exp nativerender`) says where the wall clock goes on a real
 * native-resolution take, and the answer was not what compose/render.ts is
 * written on the belief of. Its header says "the encode was never the stall —
 * measured at 23-45 ms out of a ~1900 ms render, 1.5 %", which was measured on
 * a TWELVE SECOND 1080p take. On a 60 s 3024x1964 source at the 1080p step:
 *
 *     constant quality qp20   62.1 s wall · encode-wait 51.4 s (83 %) · 58 fps
 *     bitrate target          39.7 s wall · encode-wait 38.0 s (96 %) · 91 fps
 *
 * The encoder IS the wall, and this asks it directly: what does a VideoEncoder
 * on this machine actually sustain at the export's frame size, across the axes
 * the export can choose — hardware preference, quantizer vs bitrate mode,
 * latency mode, and how many frames are allowed in flight. Nothing here touches
 * the product; it is the encoder, alone, on the same thread shape the export
 * uses (a worker).
 *
 *   node scripts/encode-cost.mjs [--frames=240] [--width=1920] [--height=1080]
 *   node scripts/encode-cost.mjs --width=3024 --height=1964 --parallel=1,2,4
 *
 * THE AVC LEVEL IS NOT A DETAIL AT MAX (R1, 2026-09-03). This rig pinned
 * `avc1.640028` = High@4.0, which caps at 8192 macroblocks (1920x1088). A max
 * frame is 3024x1964 = 23,247 macroblocks, so the first run at max came back
 * `unsupported` in all nine cells — the rig's own string, not the machine. The
 * level is now resolved per config from a ladder and PRINTED, so a future
 * "unsupported" means the encoder and not the question. The product was never
 * affected: it resolves its codec string through mediabunny's
 * `getFirstEncodableVideoCodec` (compose/codecs.ts), which picks a level that
 * fits.
 *
 * WHAT IT MEASURED AT MAX (3024x1964, 240 frames a cell, 2026-09-03, two runs):
 *
 *     quantizer qp20 (what ships)   43.3 fps · 23.1 ms/frame · queue-wait 96 %
 *     every other cell              40.5-43.6 fps — no knob on the axis matters
 *     level resolved                avc1.640033 (High@5.1)
 *     --parallel=1,2,3,4,6          43.4 · 77.2 · 77.8 · 77.8 · 77.4 aggregate
 *
 * THESE NUMBERS ARE AN UPPER BOUND ON A SYNTHETIC FRAME. THEY ARE NOT A RENDER
 * PREDICTION, and R1 paid a session to learn it: the clean 1.78x knee at two
 * sessions above is worth 1.04-1.07x on a 240 s take through the production
 * export. Two reasons, both measured — this rig has NO DECODER in it, so its
 * sessions never contend for the media engine the way a render's decode and
 * encode do (7,370 → 25,632 ms of decode at two lanes); and ONE production
 * lane sustains 84-99 fps of 3024x1964 output, above what this rig calls the
 * whole engine's ceiling, which means a cell here is partly measuring its own
 * painting. Use it to compare CONFIGS against each other, never to predict a
 * wall clock.
 *
 * --parallel=N,M runs the SHIPPED config in N separate workers at once and
 * reports AGGREGATE throughput. The sessions warm up, then hold at a barrier
 * and start together, so the measured wall is the overlap and not the spawn.
 *
 * Headed and visible on purpose: a hidden or headless Chrome may not get the
 * hardware encoder at all, and a software number here would indict the machine
 * for something only the rig did.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome } from './lib/chrome.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const FRAMES = Number(arg('frames', '240'))
const WIDTH = Number(arg('width', '1920'))
const HEIGHT = Number(arg('height', '1080'))
const PARALLEL = arg('parallel', '')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 1)
/** Robert's take: 124 minutes at 30 fps of output. */
const REAL_FRAMES = 124 * 60 * 30

/** The cells of the sweep. `codec` is a seed: the level is resolved per cell. */
const SWEEP = [
  { label: 'bitrate 8Mbps, no-preference, default latency', config: { bitrate: 8e6 } },
  { label: 'bitrate 8Mbps, PREFER-HARDWARE', config: { bitrate: 8e6, hardwareAcceleration: 'prefer-hardware' } },
  {
    label: 'bitrate 8Mbps, prefer-hardware, latencyMode realtime',
    config: { bitrate: 8e6, hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' },
  },
  { label: 'bitrate 8Mbps, PREFER-SOFTWARE', config: { bitrate: 8e6, hardwareAcceleration: 'prefer-software' } },
  { label: 'quantizer qp20, no-preference  (what ships)', config: { bitrateMode: 'quantizer' }, opts: { qp: 20 } },
  {
    label: 'quantizer qp20, PREFER-HARDWARE',
    config: { bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware' },
    opts: { qp: 20 },
  },
  {
    label: 'quantizer qp20, prefer-hardware, latencyMode realtime',
    config: { bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' },
    opts: { qp: 20 },
  },
  {
    label: 'bitrate 8Mbps, prefer-hardware, queue 16',
    config: { bitrate: 8e6, hardwareAcceleration: 'prefer-hardware' },
    opts: { queue: 16 },
  },
  {
    label: 'quantizer qp20, prefer-hardware, queue 16',
    config: { bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware' },
    opts: { qp: 20, queue: 16 },
  },
]
/** What the export actually configures, and so the only honest parallel cell. */
const SHIPPED = SWEEP.find((c) => c.label.includes('what ships'))

/**
 * SOFTWARE IS NOT A MAX-RESOLUTION QUESTION. A CPU AVC encoder at 6 Mpx takes
 * minutes per cell, and R1 has already closed the lever it would inform: a
 * different encoder cannot emit VideoToolbox's `avcC` byte for byte, so its
 * output cannot be concatenated with the hardware path's. Keeping the cell
 * above 1080p only lengthens the run — and this rig runs headed, in a window
 * over Robert's desktop.
 */
const SOFTWARE_CEILING_PX = 1920 * 1088
const cellsFor = (width, height) =>
  width * height > SOFTWARE_CEILING_PX ? SWEEP.filter((c) => !c.label.includes('PREFER-SOFTWARE')) : SWEEP

/**
 * One worker, two protocols: `sweep` runs a list of cells back to back;
 * `prepare` + `go` splits one cell so N workers can start together.
 */
const WORKER_BODY = `
let state = null;

// H.264 levels, as (hex code, MaxFS in macroblocks). A LEVEL THAT CANNOT HOLD
// THE FRAME IS NOT WORTH ASKING ABOUT: isConfigSupported on a rung too small
// costs TENS OF SECONDS here (it goes to the driver to find out), and three
// dead rungs per cell is what made the first nine-cell max sweep take 14
// minutes. The count is arithmetic, so start the ladder where it can fit.
const LEVELS = [
  { code: '1E', maxFS: 1620 },    // 3.0
  { code: '1F', maxFS: 3600 },    // 3.1
  { code: '20', maxFS: 5120 },    // 3.2
  { code: '28', maxFS: 8192 },    // 4.0  — 1920x1088 is 8160, and this is the
  { code: '29', maxFS: 8192 },    // 4.1    rung the rig used to pin for MAX
  { code: '2A', maxFS: 8704 },    // 4.2
  { code: '32', maxFS: 22080 },   // 5.0
  { code: '33', maxFS: 36864 },   // 5.1  — 3024x1964 is 23,247, so this one
  { code: '34', maxFS: 36864 },   // 5.2
  { code: '3C', maxFS: 139264 },  // 6.0
  { code: '3D', maxFS: 139264 },  // 6.1
  { code: '3E', maxFS: 139264 },  // 6.2
];

async function resolveCodec(config) {
  const mbs = Math.ceil(config.width / 16) * Math.ceil(config.height / 16);
  const ladder = LEVELS.filter((l) => l.maxFS >= mbs);
  for (const l of ladder) {
    const codec = 'avc1.6400' + l.code;
    try {
      const s = await VideoEncoder.isConfigSupported({ ...config, codec });
      if (s && s.supported === true) return codec;
    } catch (e) { /* a level this build does not know */ }
  }
  return null;
}

function painter(canvas, ctx, width, height) {
  // Content that costs an encoder something: a moving gradient plus noise
  // blocks, so no cell codes as "unchanged".
  return (i) => {
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, 'hsl(' + ((i * 3) % 360) + ',60%,30%)');
    g.addColorStop(1, 'hsl(' + ((i * 3 + 120) % 360) + ',60%,60%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    for (let k = 0; k < 300; k++) {
      ctx.fillRect((k * 137 + i * 7) % width, (k * 89 + i * 3) % height, 24, 10);
    }
  };
}

/** Configure + warm. The first frames pay session setup no later frame pays. */
async function prepare(cell, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  const paint = painter(canvas, ctx, width, height);
  const qp = cell.opts && cell.opts.qp;
  const queue = (cell.opts && cell.opts.queue) ?? 4;
  const seed = { codec: 'avc1.640028', width, height, framerate: 30, ...cell.config };
  const codec = await resolveCodec(seed);
  if (!codec) return { error: 'unsupported at every AVC level' };
  const config = { ...seed, codec };
  const box = { out: 0, bytes: 0, err: null };
  const enc = new VideoEncoder({
    output: (c) => { box.out++; box.bytes += c.byteLength; },
    error: (e) => { box.err = e.message; },
  });
  try { enc.configure(config); } catch (e) { return { error: 'configure threw: ' + e.message }; }
  for (let i = 0; i < 6; i++) {
    paint(i);
    const f = new VideoFrame(canvas, { timestamp: (i * 1e6) / 30 });
    enc.encode(f, qp === undefined ? undefined : { quantizer: qp });
    f.close();
  }
  await enc.flush();
  if (box.err) return { error: box.err };
  return { enc, box, paint, canvas, codec, qp, queue, label: cell.label };
}

/** The measured loop: the same shape render.ts drives through mediabunny. */
async function run(st, frames) {
  const { enc, box, paint, canvas, qp, queue } = st;
  box.out = 0; box.bytes = 0;
  let waited = 0;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    paint(i);
    const f = new VideoFrame(canvas, { timestamp: ((i + 6) * 1e6) / 30 });
    enc.encode(f, qp === undefined ? undefined : { quantizer: qp });
    f.close();
    // What render.ts does through mediabunny: hold the queue to a small depth,
    // awaiting when it is full. THIS is the loop's 'encode-wait'.
    while (enc.encodeQueueSize > queue) {
      const w0 = performance.now();
      await new Promise((r) => setTimeout(r, 0));
      waited += performance.now() - w0;
      if (box.err) break;
    }
    if (box.err) break;
  }
  await enc.flush();
  const ms = performance.now() - t0;
  try { enc.close(); } catch (e) {}
  if (box.err) return { label: st.label, error: box.err };
  return {
    label: st.label,
    codec: st.codec,
    fps: Math.round((frames / (ms / 1000)) * 10) / 10,
    perFrameMs: Math.round((ms / frames) * 1000) / 1000,
    waitPct: Math.round((waited / ms) * 100),
    kbPerFrame: Math.round(box.bytes / Math.max(1, box.out) / 102.4) / 10,
    ms: Math.round(ms),
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'sweep') {
    const results = [];
    for (const cell of msg.cells) {
      const st = await prepare(cell, msg.width, msg.height);
      if (st.error) { results.push({ label: cell.label, error: st.error }); continue; }
      results.push(await run(st, msg.frames));
    }
    self.postMessage({ type: 'sweep', results });
    return;
  }
  if (msg.type === 'prepare') {
    const st = await prepare(msg.cell, msg.width, msg.height);
    if (st.error) { self.postMessage({ type: 'ready', error: st.error }); return; }
    state = { st, frames: msg.frames };
    self.postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'go') {
    self.postMessage({ type: 'done', result: await run(state.st, state.frames) });
  }
};
`

const SWEEP_PAGE = (frames, width, height, cells) => `
(async () => {
  const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_BODY)}], { type: 'text/javascript' }));
  const w = new Worker(url);
  const done = new Promise((res) => { w.onmessage = (e) => res(e.data.results); });
  w.postMessage({ type: 'sweep', frames: ${frames}, width: ${width}, height: ${height}, cells: ${JSON.stringify(cells)} });
  const r = await done;
  w.terminate();
  return JSON.stringify(r);
})()
`

/**
 * N encoder sessions, started at a barrier. The wall measured here is the
 * OVERLAP: every session has already configured and warmed before the clock
 * starts, so a slow spawn cannot be read as a slow engine.
 */
const PARALLEL_PAGE = (frames, width, height, ns, cell) => `
(async () => {
  const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER_BODY)}], { type: 'text/javascript' }));
  const cell = ${JSON.stringify(cell)};
  const runN = async (n) => {
    const ws = [], ready = [], done = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(url);
      ws.push(w);
      let onReady, onDone;
      ready.push(new Promise((res) => { onReady = res; }));
      done.push(new Promise((res) => { onDone = res; }));
      w.onmessage = (e) => { if (e.data.type === 'ready') onReady(e.data); else onDone(e.data.result); };
      w.postMessage({ type: 'prepare', frames: ${frames}, width: ${width}, height: ${height}, cell });
    }
    const readies = await Promise.all(ready);
    const bad = readies.find((r) => r.error);
    if (bad) { for (const w of ws) w.terminate(); return { n, error: bad.error }; }
    const t0 = performance.now();
    for (const w of ws) w.postMessage({ type: 'go' });
    const rows = await Promise.all(done);
    const wallMs = performance.now() - t0;
    for (const w of ws) w.terminate();
    const err = rows.find((r) => r.error);
    if (err) return { n, error: err.error };
    return {
      n,
      wallMs: Math.round(wallMs),
      aggFps: Math.round(((n * ${frames}) / (wallMs / 1000)) * 10) / 10,
      per: rows.map((r) => r.fps),
      codec: rows[0].codec,
      waitPct: Math.round(rows.reduce((a, r) => a + r.waitPct, 0) / rows.length),
      kbPerFrame: rows[0].kbPerFrame,
    };
  };
  const out = [];
  for (const n of ${JSON.stringify(ns)}) out.push(await runN(n));
  return JSON.stringify(out);
})()
`

/**
 * A SECURE CONTEXT IS NOT OPTIONAL: WebCodecs is undefined on about:blank (an
 * opaque origin) and a blob worker spawned there inherits that. localhost IS a
 * secure context, so an empty page served from one is the smallest thing that
 * works — and unlike a real site it cannot navigate out from under the
 * evaluate, which is what a deployed SPA with a service worker does.
 */
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>encode-cost</title>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const profile = mkdtempSync(join(tmpdir(), 'inout-enccost-'))
let session = null
const pad = (s, n) => String(s).padEnd(n)
/**
 * `evalJson` holds the lib's 30 s default, and a max-resolution sweep is nine
 * cells of 240 frames — the first run at 3024x1964 died on that timeout, not on
 * the encoder. Ask for the wall this rig actually needs.
 */
const evalRows = async (expr) => {
  const v = await session.evaluate(expr, 900_000)
  return typeof v === 'string' ? JSON.parse(v) : v
}
try {
  session = await launchChromeRetrying({
    bin: resolveChrome(),
    profile,
    url: `http://localhost:${port}/`,
    headed: true,
  })
  // The debug target is attached while the first navigation is still in flight,
  // so an evaluate fired straight away dies with "Execution context was
  // destroyed". Wait for the page to actually BE the page.
  for (let i = 0; i < 100; i++) {
    try {
      const here = await session.evaluate('location.origin')
      if (here === `http://localhost:${port}`) break
    } catch {
      /* context still swapping */
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (PARALLEL.length) {
    const rows = await evalRows(PARALLEL_PAGE(FRAMES, WIDTH, HEIGHT, PARALLEL, SHIPPED))
    if (!rows) throw new Error('the worker returned nothing')
    console.log(
      `\nPARALLEL ENCODER SESSIONS AT ${WIDTH}x${HEIGHT} — ${SHIPPED.label}, ${FRAMES} frames per session\n`,
    )
    console.log(
      `  ${pad('n', 4)} ${pad('aggregate fps', 15)} ${pad('per session', 26)} ${pad('wall s', 9)} ${pad('queue-wait', 11)} vs n=1`,
    )
    const one = rows.find((r) => r.n === 1 && !r.error)
    for (const r of rows) {
      if (r.error) {
        console.log(`  ${pad(r.n, 4)} — ${r.error}`)
        continue
      }
      const scale = one ? `${Math.round((r.aggFps / one.aggFps) * 100) / 100}x` : '—'
      console.log(
        `  ${pad(r.n, 4)} ${pad(r.aggFps, 15)} ${pad(r.per.join(' '), 26)} ${pad((r.wallMs / 1000).toFixed(2), 9)} ${pad(r.waitPct + '%', 11)} ${scale}`,
      )
    }
    const best = rows.filter((r) => !r.error).sort((a, b) => b.aggFps - a.aggFps)[0]
    if (one && best) {
      const h = (fps) => (REAL_FRAMES / fps / 3600).toFixed(2)
      console.log(
        `\n  codec resolved: ${one.codec} · ${one.kbPerFrame} kB/frame` +
          `\n  encode alone over Robert's 124-minute take at 30 fps:` +
          `\n    one session:  ${h(one.aggFps)} h` +
          `\n    ${best.n} sessions: ${h(best.aggFps)} h\n`,
      )
    }
  } else {
    const rows = await evalRows(SWEEP_PAGE(FRAMES, WIDTH, HEIGHT, cellsFor(WIDTH, HEIGHT)))
    if (!rows) throw new Error('the worker returned nothing')

    console.log(`\nENCODER THROUGHPUT AT ${WIDTH}x${HEIGHT}, ${FRAMES} frames per cell, in a worker\n`)
    console.log(
      `  ${pad('config', 54)} ${pad('fps', 8)} ${pad('ms/frame', 10)} ${pad('queue-wait', 11)} ${pad('kB/frame', 10)} level`,
    )
    for (const r of rows) {
      if (r.error) {
        console.log(`  ${pad(r.label, 54)} — ${r.error}`)
        continue
      }
      console.log(
        `  ${pad(r.label, 54)} ${pad(r.fps, 8)} ${pad(r.perFrameMs, 10)} ${pad(r.waitPct + '%', 11)} ${pad(r.kbPerFrame, 10)} ${r.codec}`,
      )
    }
    const best = rows.filter((r) => !r.error).sort((a, b) => b.fps - a.fps)[0]
    const ship = rows.find((r) => r.label.includes('what ships'))
    console.log('')
    if (ship && !ship.error && best) {
      const h = (fps) => (REAL_FRAMES / fps / 3600).toFixed(2)
      console.log(
        `  encode alone over Robert's 124-minute take at 30 fps:\n` +
          `    what ships (${ship.label}): ${h(ship.fps)} h\n` +
          `    fastest here (${best.label}): ${h(best.fps)} h\n`,
      )
    }
  }
} finally {
  if (session) await quitChrome(session)
  rmSync(profile, { recursive: true, force: true })
  server.close()
}
