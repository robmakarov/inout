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
/** Robert's take: 124 minutes at 30 fps of output. */
const REAL_FRAMES = 124 * 60 * 30

const PAGE = (frames, width, height) => `
(async () => {
  const workerSrc = String.raw\`
    self.onmessage = async (ev) => {
      const { frames, width, height } = ev.data;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false });
      // Content that costs an encoder something: a moving gradient plus noise
      // blocks, so no cell codes as "unchanged".
      const paint = (i) => {
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

      async function bench(label, config, opts) {
        const { qp, queue } = opts || {};
        let support;
        try {
          support = await VideoEncoder.isConfigSupported(config);
        } catch (e) {
          return { label, error: 'isConfigSupported threw: ' + e.message };
        }
        if (!support || support.supported !== true) return { label, error: 'unsupported' };
        let out = 0, bytes = 0, err = null;
        const enc = new VideoEncoder({
          output: (c) => { out++; bytes += c.byteLength; },
          error: (e) => { err = e.message; },
        });
        try {
          enc.configure(config);
        } catch (e) {
          return { label, error: 'configure threw: ' + e.message };
        }
        const maxQueue = queue ?? 4;
        // Warm: the first frames pay session setup no later frame pays.
        for (let i = 0; i < 6; i++) {
          paint(i);
          const f = new VideoFrame(canvas, { timestamp: (i * 1e6) / 30 });
          enc.encode(f, qp === undefined ? undefined : { quantizer: qp });
          f.close();
        }
        await enc.flush();
        if (err) return { label, error: err };
        out = 0; bytes = 0;
        let waited = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          paint(i);
          const f = new VideoFrame(canvas, { timestamp: ((i + 6) * 1e6) / 30 });
          enc.encode(f, qp === undefined ? undefined : { quantizer: qp });
          f.close();
          // What render.ts does through mediabunny: hold the queue to a small
          // depth, awaiting when it is full. THIS is the loop's 'encode-wait'.
          while (enc.encodeQueueSize > maxQueue) {
            const w0 = performance.now();
            await new Promise((r) => setTimeout(r, 0));
            waited += performance.now() - w0;
            if (err) break;
          }
          if (err) break;
        }
        await enc.flush();
        const ms = performance.now() - t0;
        try { enc.close(); } catch {}
        if (err) return { label, error: err };
        return {
          label,
          fps: Math.round((frames / (ms / 1000)) * 10) / 10,
          perFrameMs: Math.round((ms / frames) * 1000) / 1000,
          waitPct: Math.round((waited / ms) * 100),
          kbPerFrame: Math.round(bytes / Math.max(1, out) / 102.4) / 10,
        };
      }

      const base = { codec: 'avc1.640028', width, height, framerate: 30 };
      const results = [];
      results.push(await bench('bitrate 8Mbps, no-preference, default latency',
        { ...base, bitrate: 8e6 }));
      results.push(await bench('bitrate 8Mbps, PREFER-HARDWARE',
        { ...base, bitrate: 8e6, hardwareAcceleration: 'prefer-hardware' }));
      results.push(await bench('bitrate 8Mbps, prefer-hardware, latencyMode realtime',
        { ...base, bitrate: 8e6, hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' }));
      results.push(await bench('bitrate 8Mbps, PREFER-SOFTWARE',
        { ...base, bitrate: 8e6, hardwareAcceleration: 'prefer-software' }));
      results.push(await bench('quantizer qp20, no-preference  (what ships)',
        { ...base, bitrateMode: 'quantizer' }, { qp: 20 }));
      results.push(await bench('quantizer qp20, PREFER-HARDWARE',
        { ...base, bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware' }, { qp: 20 }));
      results.push(await bench('quantizer qp20, prefer-hardware, latencyMode realtime',
        { ...base, bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' }, { qp: 20 }));
      results.push(await bench('bitrate 8Mbps, prefer-hardware, queue 16',
        { ...base, bitrate: 8e6, hardwareAcceleration: 'prefer-hardware' }, { queue: 16 }));
      results.push(await bench('quantizer qp20, prefer-hardware, queue 16',
        { ...base, bitrateMode: 'quantizer', hardwareAcceleration: 'prefer-hardware' }, { qp: 20, queue: 16 }));
      self.postMessage(results);
    };
  \`;
  const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  const w = new Worker(url);
  const done = new Promise((res) => { w.onmessage = (e) => res(e.data); });
  w.postMessage({ frames: ${frames}, width: ${width}, height: ${height} });
  const r = await done;
  w.terminate();
  return JSON.stringify(r);
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
  const rows = await session.evalJson(PAGE(FRAMES, WIDTH, HEIGHT), null)
  if (!rows) throw new Error('the worker returned nothing')

  console.log(`\nENCODER THROUGHPUT AT ${WIDTH}x${HEIGHT}, ${FRAMES} frames per cell, in a worker\n`)
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`  ${pad('config', 54)} ${pad('fps', 8)} ${pad('ms/frame', 10)} ${pad('queue-wait', 11)} kB/frame`)
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${pad(r.label, 54)} — ${r.error}`)
      continue
    }
    console.log(
      `  ${pad(r.label, 54)} ${pad(r.fps, 8)} ${pad(r.perFrameMs, 10)} ${pad(r.waitPct + '%', 11)} ${r.kbPerFrame}`,
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
} finally {
  if (session) await quitChrome(session)
  rmSync(profile, { recursive: true, force: true })
  server.close()
}
