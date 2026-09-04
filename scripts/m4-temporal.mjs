#!/usr/bin/env node
/**
 * M4 — CAN A 60 fps FILE CARRY A 30 fps FILE INSIDE IT? (idea 25, probe only.)
 *
 * THE QUESTION AND WHY IT IS WORTH ASKING. A sub-max export today is a
 * RE-ENCODE: 60 fps in, 30 fps out, every frame decoded and encoded again, and
 * R1 established that the render's ceiling IS the encode silicon. If the
 * capture encoder can emit a temporally scalable stream — `scalabilityMode:
 * 'L1T2'`, one spatial layer, two temporal layers — then the 30 fps version of
 * a take is already inside the 60 fps file, and making it is DROPPING PACKETS
 * rather than encoding any. The same property is what a future stream would
 * shed under pressure. M1 decides whether any of that ships; this only answers
 * whether the platform can do it at all, and what it costs.
 *
 * WHAT IT ANSWERS, in the order the gates ask:
 *   1. yes/no per codec, with the exact config that worked, on prod Chrome —
 *      and `isConfigSupported` is NOT the answer on its own: Chrome accepts a
 *      config and echoes it back with `scalabilityMode` INTACT while emitting a
 *      single layer, so support is only believed when the chunks carry
 *      `metadata.svc.temporalLayerId` and it actually alternates.
 *   2. does the base layer stand alone — proved by DECODING it: the T1 chunks
 *      are dropped and a fresh VideoDecoder is fed only T0. If the layering is
 *      real, every base frame comes out and nothing errors; if the enhancement
 *      frames were reference frames after all, the decoder says so.
 *   3. what the layering COSTS, at the quantizer the product ships (qp20), as
 *      three encodes of the same frames:
 *        A  L1T1 at 60 fps   = today's flat file
 *        B  L1T2 at 60 fps   = the scalable file, and its T0 half
 *        C  L1T1 at 30 fps   = what a sub-max export re-encodes to today
 *      The numbers that matter are B/A (what the whole file grows by) and
 *      B-T0/C (what selecting packets gives you against encoding properly).
 *
 *   node scripts/m4-temporal.mjs
 *   node scripts/m4-temporal.mjs --width=1920 --height=1080 --frames=120
 *   node scripts/m4-temporal.mjs --codecs=avc,hevc,vp9,av1
 *
 * Probe only: it touches no product code and ships nothing. The verdict goes to
 * .ai/TASKS and DECISIONS as a sentence for M1.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome } from './lib/chrome.mjs'

const args = process.argv.slice(2)
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
/** Max, because that is the rung the question is about: 60 fps at the screen's
 *  own size is what a sub-max export re-encodes away from. */
const WIDTH = Number(arg('width', '3024'))
const HEIGHT = Number(arg('height', '1964'))
const FRAMES = Number(arg('frames', '120'))
const CODECS = arg('codecs', 'avc,hevc,vp9,av1').split(',')
const OUT = arg('out', join(tmpdir(), `m4-temporal-${Date.now()}.json`))
/** Where the timestamp-spacing walk starts; it halves until nothing drops. */
const START_RATE = Number(arg('rate', '30'))
/** `--save=<dir>` writes the base-only and whole Annex-B streams for the gate. */
const SAVE = arg('save', '')

/**
 * Everything runs in the page, in one evaluate: WebCodecs needs a secure
 * context and a browser, and splitting it over several evaluates would make
 * every encoder session a different Chrome state (encode-cost.mjs's lesson).
 */
const PAGE = (width, height, frames, codecs, startRate, save) => `
(async () => {
  const WIDTH = ${width}, HEIGHT = ${height}, FRAMES = ${frames};
  const WANT = ${JSON.stringify(codecs)};
  const START_RATE = ${startRate};

  // Level ladders, lifted from encode-cost.mjs with its reason: asking about a
  // rung too small for the frame costs tens of seconds per dead rung, and the
  // count is arithmetic, so the ladder starts where the frame can fit.
  const AVC_LEVELS = [
    { code: '1E', maxFS: 1620 }, { code: '1F', maxFS: 3600 }, { code: '20', maxFS: 5120 },
    { code: '28', maxFS: 8192 }, { code: '29', maxFS: 8192 }, { code: '2A', maxFS: 8704 },
    { code: '32', maxFS: 22080 }, { code: '33', maxFS: 36864 }, { code: '34', maxFS: 36864 },
    { code: '3C', maxFS: 139264 }, { code: '3D', maxFS: 139264 }, { code: '3E', maxFS: 139264 },
  ];
  const HEVC_LEVELS = [
    { code: 'L120', maxPx: 2228224 }, { code: 'L123', maxPx: 2228224 },
    { code: 'L150', maxPx: 8912896 }, { code: 'L153', maxPx: 8912896 },
    { code: 'L156', maxPx: 8912896 }, { code: 'L180', maxPx: 35651584 },
  ];
  function candidates(family) {
    if (family === 'avc') {
      const mbs = Math.ceil(WIDTH / 16) * Math.ceil(HEIGHT / 16);
      return AVC_LEVELS.filter((l) => l.maxFS >= mbs).map((l) => 'avc1.6400' + l.code);
    }
    if (family === 'hevc') {
      const px = WIDTH * HEIGHT;
      return HEVC_LEVELS.filter((l) => l.maxPx >= px).map((l) => 'hvc1.1.6.' + l.code + '.B0');
    }
    if (family === 'vp9') return ['vp09.00.10.08'];
    if (family === 'av1') return ['av01.0.08M.08'];
    return [];
  }

  // Content an encoder has to pay for, so no frame codes as "unchanged" and a
  // dropped enhancement layer is visible in the bytes.
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  function paint(i) {
    const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    g.addColorStop(0, 'hsl(' + ((i * 7) % 360) + ',80%,50%)');
    g.addColorStop(1, 'hsl(' + ((i * 11 + 180) % 360) + ',80%,30%)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = 'rgba(' + ((i * k) % 255) + ',' + ((i + k * 9) % 255) + ',' + ((k * 31) % 255) + ',0.9)';
      ctx.fillRect(((i * 37 + k * 91) % WIDTH), ((i * 53 + k * 71) % HEIGHT), 120, 80);
    }
    // A moving hard edge: what a 30 fps layer alone should still show moving.
    ctx.fillStyle = '#fff';
    ctx.fillRect((i * 19) % (WIDTH - 60), HEIGHT / 2, 60, 60);
  }
  // NO RING, AND THAT IS THE OPPOSITE OF THE RIG NEXT DOOR — deliberately.
  // encode-cost.mjs pre-paints a ring because it measures SPEED and must keep
  // its own 2D drawing out of the timed loop. This measures BYTES, where the
  // drawing costs nothing and a repeating ring is a lie: with 30 pictures under
  // 60 submissions every base-layer frame appeared TWICE, and the base layer
  // read 0.519x a real half-rate encode purely from that redundancy. Every
  // frame here is its own picture.
  function frameAt(i, tsRate) {
    paint(i);
    return new VideoFrame(canvas, {
      timestamp: Math.round((i * 1e6) / tsRate),
      duration: Math.round(1e6 / tsRate),
    });
  }

  /** One encode. Returns per-chunk bytes AND the layer id the encoder stamped. */
  async function encode({ codec, framerate, scalabilityMode, hw, tsRate, frames, stride }) {
    const N = frames || FRAMES;
    const chunks = [];
    let decoderConfig = null;
    let configError = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        chunks.push({
          bytes: chunk.byteLength,
          type: chunk.type,
          timestamp: chunk.timestamp,
          // THE ONLY HONEST ANSWER TO "did it layer?" — the config echo is not
          // one, because Chrome hands the mode back and may still emit one layer.
          layer: meta && meta.svc && typeof meta.svc.temporalLayerId === 'number'
            ? meta.svc.temporalLayerId : null,
          data: buf,
        });
        if (meta && meta.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
      },
      error: (e) => { configError = String(e); },
    });
    const config = {
      codec, width: WIDTH, height: HEIGHT, framerate,
      bitrateMode: 'quantizer',
      latencyMode: 'quality',
      hardwareAcceleration: hw,
      ...(scalabilityMode ? { scalabilityMode } : {}),
    };
    let support = null;
    try { support = await VideoEncoder.isConfigSupported(config); } catch (e) { return { error: 'isConfigSupported threw: ' + e }; }
    if (!support || support.supported !== true) return { unsupported: true, config };
    // WHAT THE BROWSER GAVE BACK. A config echoed WITHOUT scalabilityMode is
    // the browser saying it will ignore it, and that is a no before any frame.
    const echoed = support.config || {};
    try { enc.configure(config); } catch (e) { return { error: 'configure threw: ' + e }; }
    const t0 = performance.now();
    // SUBMITTED IS COUNTED, and it is not a formality: a rig that hands over 60
    // frames and reports 21 chunks has to be able to say which half is wrong.
    let submitted = 0, submitError = null;
    for (let i = 0; i < N; i++) {
      try {
        // The half-rate arm walks the SAME pictures two at a time, so both arms
        // see the same content over the same span — otherwise the comparison is
        // between two different films.
        const frame = frameAt(i * (stride || 1), tsRate || framerate);
        // qp20 is what the product ships (Q1, the quantizer means what it says).
        enc.encode(frame, { keyFrame: i % 120 === 0, quantizer: 20 });
        frame.close();
        submitted++;
      } catch (e) { submitError = 'frame ' + i + ': ' + e; break; }
      // The proven wait (encode-cost.mjs): POLL the queue depth. The first cut
      // used the ondequeue callback and it is not a reliable wake here.
      while (enc.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 0));
        if (configError) break;
      }
      if (configError) break;
    }
    await enc.flush();
    const wallMs = performance.now() - t0;
    enc.close();
    if (configError) return { error: configError };
    const layers = {};
    for (const c of chunks) layers[String(c.layer)] = (layers[String(c.layer)] || 0) + 1;
    return {
      codec, framerate, scalabilityMode: scalabilityMode || 'none', hw,
      echoedScalabilityMode: echoed.scalabilityMode ?? null,
      submitted,
      submitError,
      // THE ENCODER DROPS AND SAYS NOTHING — measured on this machine, see the
      // header. A cell that lost frames cannot be compared by bytes with one
      // that did not, so it carries the fact rather than a quiet number.
      keptEveryFrame: chunks.length === submitted,
      frames: chunks.length,
      bytes: chunks.reduce((s, c) => s + c.bytes, 0),
      keyFrames: chunks.filter((c) => c.type === 'key').length,
      layerCounts: layers,
      layeredForReal: Object.keys(layers).filter((k) => k !== 'null').length > 1,
      wallMs: Math.round(wallMs),
      decoderConfig: decoderConfig ? {
        codec: decoderConfig.codec, codedWidth: decoderConfig.codedWidth,
        codedHeight: decoderConfig.codedHeight,
        description: decoderConfig.description ? true : false,
      } : null,
      _chunks: chunks,
      _decoderConfig: decoderConfig,
    };
  }

  /**
   * GATE 2 — DOES THE BASE LAYER STAND ALONE? Feed a fresh decoder ONLY the
   * temporalLayerId===0 chunks. If the enhancement frames were never referenced
   * by the base, every base frame decodes; if they were, the decoder errors or
   * comes up short, and that is the whole answer.
   */
  async function decodeBaseOnly(run) {
    const base = run._chunks.filter((c) => c.layer === 0);
    if (!base.length) return { error: 'no base-layer chunks to try' };

    // THUMBNAILS, NOT A FRAME COUNT. Counting decoder outputs is NOT the test:
    // a decoder handed a stream whose references are missing CONCEALS the hole
    // and emits a picture anyway, so "30 frames came out, no error" is exactly
    // what a broken base layer looks like. Compare the PIXELS against the same
    // frames decoded from the whole stream.
    const small = new OffscreenCanvas(64, 64);
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const thumb = (f) => {
      sctx.drawImage(f, 0, 0, 64, 64);
      return sctx.getImageData(0, 0, 64, 64).data.slice();
    };
    async function decodeAll(chunks) {
      const thumbs = [];
      let error = null;
      const dec = new VideoDecoder({
        output: (f) => { try { thumbs.push({ ts: f.timestamp, px: thumb(f) }) } finally { f.close() } },
        error: (e) => { error = String(e); },
      });
      try { dec.configure({ ...run._decoderConfig }); } catch (e) { return { error: 'configure: ' + e }; }
      for (const c of chunks) {
        if (error) break;
        try {
          dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, data: c.data }));
        } catch (e) { error = 'decode threw: ' + e; break; }
      }
      try { await dec.flush(); } catch (e) { error = error || ('flush threw: ' + e); }
      try { dec.close(); } catch (e) { /* already gone */ }
      return { thumbs, error };
    }

    const whole = await decodeAll(run._chunks);
    const only = await decodeAll(base);
    if (whole.error) return { error: 'the whole stream would not decode: ' + whole.error };
    if (only.error) {
      return { baseChunks: base.length, standsAlone: false, error: only.error };
    }
    // Pair by timestamp and measure how far apart the pictures are, 0-255.
    const byTs = new Map(whole.thumbs.map((t) => [t.ts, t.px]));
    let worst = 0, sum = 0, paired = 0;
    for (const t of only.thumbs) {
      const ref = byTs.get(t.ts);
      if (!ref) continue;
      let d = 0;
      for (let i = 0; i < ref.length; i += 4) d += Math.abs(ref[i] - t.px[i]);
      d = d / (ref.length / 4);
      sum += d; paired++;
      if (d > worst) worst = d;
    }
    const meanDiff = paired ? sum / paired : null;
    return {
      baseChunks: base.length,
      baseBytes: base.reduce((s, c) => s + c.bytes, 0),
      decodedFrames: only.thumbs.length,
      pairedFrames: paired,
      meanPixelDiff: meanDiff === null ? null : Math.round(meanDiff * 100) / 100,
      worstPixelDiff: Math.round(worst * 100) / 100,
      // A base layer that truly stands alone decodes to the SAME pictures the
      // whole stream gives at those timestamps. 2/255 is codec noise; 20 is a
      // different picture.
      standsAlone: only.thumbs.length === base.length && paired > 0 && worst < 6,
      error: null,
    };
  }

  const SAVE = ${save};
  let savedOne = false;
  /** AVCC -> Annex-B. The description is an avcC box: SPS and PPS by length. */
  function toAnnexB(chunks, desc) {
    const parts = [];
    const START = [0, 0, 0, 1];
    if (desc && desc.length > 7) {
      let o = 5;
      const nSps = desc[o++] & 0x1f;
      for (let i = 0; i < nSps; i++) {
        const len = (desc[o] << 8) | desc[o + 1]; o += 2;
        parts.push(START, Array.from(desc.subarray(o, o + len))); o += len;
      }
      const nPps = desc[o++];
      for (let i = 0; i < nPps; i++) {
        const len = (desc[o] << 8) | desc[o + 1]; o += 2;
        parts.push(START, Array.from(desc.subarray(o, o + len))); o += len;
      }
    }
    for (const c of chunks) {
      const d = c.data;
      let o = 0;
      while (o + 4 <= d.length) {
        const len = (d[o] << 24 >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
        o += 4;
        if (len <= 0 || o + len > d.length) break;
        parts.push(START, Array.from(d.subarray(o, o + len)));
        o += len;
      }
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let w = 0;
    for (const p of parts) { out.set(p, w); w += p.length; }
    // Base64 so it can come back through one evaluate.
    let bin = '';
    for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode.apply(null, out.subarray(i, i + 8192));
    return btoa(bin);
  }

  const rows = [];
  for (const family of WANT) {
    for (const hw of ['prefer-hardware', 'prefer-software']) {
      // Resolve the level ONCE per family+hw, on the plain L1T1 config: a level
      // that cannot hold the frame is not a statement about layering.
      let codec = null;
      for (const c of candidates(family)) {
        try {
          const s = await VideoEncoder.isConfigSupported({
            codec: c, width: WIDTH, height: HEIGHT, framerate: 60,
            bitrateMode: 'quantizer', hardwareAcceleration: hw,
          });
          if (s && s.supported === true) { codec = c; break; }
        } catch (e) { /* a level this build does not know */ }
      }
      if (!codec) { rows.push({ family, hw, error: 'no level supported at ' + WIDTH + 'x' + HEIGHT }); continue; }

      // WHY THE RATE IS FOUND RATHER THAN CHOSEN (this rig's own finding, in
      // the header): bitrateMode 'quantizer' — what the product ships — makes
      // this encoder DROP frames silently, more of them the closer together
      // the timestamps are, and the fraction MOVES between runs (60 of 60 kept
      // at 15 fps spacing; 59, then 41, at 30; 44 at 60; 21-44 at 120). A
      // bitrate target keeps every frame at every rate. Bytes from cells that
      // kept different numbers of frames are not comparable, so the plan walks
      // the spacing DOWN until every cell keeps everything, and says which
      // rate it settled on. The question is a 2:1 temporal split and it does
      // not care what the two rates are called.
      let full = null, svc = null, half = null, rate = START_RATE, tries = 0;
      while (tries++ < 4) {
        full = await encode({ codec, framerate: rate, tsRate: rate, scalabilityMode: null, hw });
        svc = await encode({ codec, framerate: rate, tsRate: rate, scalabilityMode: 'L1T2', hw });
        half = await encode({ codec, framerate: rate / 2, tsRate: rate / 2, scalabilityMode: null, hw, frames: Math.floor(FRAMES / 2), stride: 2 });
        if ([full, svc, half].every((c) => c && c.keptEveryFrame)) break;
        rate = rate / 2;
      }
      // THE CONTROL FOR THE COST LINE. The half-rate arm above declares half
      // the framerate, which is what a real sub-max export would do — but if
      // the DECLARED rate is what moves the bytes rather than the pictures,
      // the cost line is measuring the wrong thing. This arm is the same 30
      // pictures at the same spacing with the FULL rate declared.
      const halfSameRate = await encode({ codec, framerate: rate, tsRate: rate / 2, scalabilityMode: null, hw, frames: Math.floor(FRAMES / 2), stride: 2 });
      const svcT3 = await encode({ codec, framerate: rate, tsRate: rate, scalabilityMode: 'L1T3', hw });
      const flat60 = full, svc60 = svc, flat30 = half, svc60t3 = svcT3;
      const row = {
        family, hw, codec, measuredAtFps: rate, rateTries: tries,
        halfSameRate: strip(halfSameRate),
        flat60: strip(flat60), svc60: strip(svc60), flat30: strip(flat30), svc60t3: strip(svc60t3),
      };
      if (svc60 && svc60.layeredForReal) row.baseAlone = await decodeBaseOnly(svc60);
      // GATE 2 WANTS A FILE, not only a decode. AVC chunks come out of
      // WebCodecs in AVCC form (4-byte lengths, parameter sets in the
      // decoderConfig description); an Annex-B elementary stream is the same
      // data with start codes and the SPS/PPS in front, and every player reads
      // it. Written for the first hardware row that layers.
      if (SAVE && family === 'avc' && svc60 && svc60.layeredForReal && !savedOne) {
        savedOne = true;
        const desc = svc60._decoderConfig && svc60._decoderConfig.description
          ? new Uint8Array(svc60._decoderConfig.description) : null;
        row.annexB = {
          base: toAnnexB(svc60._chunks.filter((c) => c.layer === 0), desc),
          whole: toAnnexB(svc60._chunks, desc),
          codec: svc60._decoderConfig ? svc60._decoderConfig.codec : null,
        };
      }
      // A cost line is only printed when EVERY cell it is made of kept every
      // frame it was handed.
      const clean = [flat60, svc60, flat30].every((c) => c && c.keptEveryFrame);
      row.cellsKeptEveryFrame = clean;
      if (!clean) row.costRefused = 'a cell lost frames to the quantizer-mode drop — bytes not comparable';
      if (clean && svc60 && svc60.layeredForReal && flat30 && flat30.bytes) {
        const baseBytes = svc60._chunks.filter((c) => c.layer === 0).reduce((s, c) => s + c.bytes, 0);
        row.cost = {
          svcOverFlat: +(svc60.bytes / flat60.bytes).toFixed(3),
          baseShareOfSvc: +(baseBytes / svc60.bytes).toFixed(3),
          // TWO COMPARISONS, because they answer different questions and the
          // first one is confounded on purpose. baseOverTodaysExport is what a
          // sub-max export produces TODAY, declaring the output's own rate —
          // and this encoder charges 1.84x for identical pictures purely for
          // declaring half the framerate (measured: 9168 vs 4992 B/frame).
          // baseOverLikeForLike holds the declared rate constant, so it is what the
          // LAYERING costs and nothing else.
          baseOverTodaysExport: +(baseBytes / flat30.bytes).toFixed(3),
          baseOverLikeForLike: halfSameRate && halfSameRate.bytes
            ? +(baseBytes / halfSameRate.bytes).toFixed(3) : null,
          bytesPerFrame: {
            flat: Math.round(flat60.bytes / flat60.frames),
            svc: Math.round(svc60.bytes / svc60.frames),
            base: Math.round(baseBytes / svc60._chunks.filter((c) => c.layer === 0).length),
            todaysExport: Math.round(flat30.bytes / flat30.frames),
            likeForLike: halfSameRate && halfSameRate.frames
              ? Math.round(halfSameRate.bytes / halfSameRate.frames) : null,
          },
        };
      }
      rows.push(row);
    }
  }
  function strip(r) {
    if (!r) return r;
    const { _chunks, _decoderConfig, ...rest } = r;
    return rest;
  }
  return JSON.stringify({ width: WIDTH, height: HEIGHT, frames: FRAMES, rows });
})()
`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>m4-temporal</title>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const profile = mkdtempSync(join(tmpdir(), 'inout-m4-'))
let session = null
const pad = (s, n) => String(s).padEnd(n)

try {
  session = await launchChromeRetrying({
    bin: resolveChrome(),
    profile,
    url: `http://localhost:${port}/`,
    headed: true,
  })
  for (let i = 0; i < 100; i++) {
    try {
      if ((await session.evaluate('location.origin')) === `http://localhost:${port}`) break
    } catch {
      /* context still swapping */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const raw = await session.evaluate(PAGE(WIDTH, HEIGHT, FRAMES, CODECS, START_RATE, SAVE ? 'true' : 'false'), 900_000)
  const out = typeof raw === 'string' ? JSON.parse(raw) : raw
  writeFileSync(OUT, JSON.stringify(out, null, 2))

  console.log(`\nM4 — TEMPORAL LAYERS AT ${WIDTH}x${HEIGHT}, ${FRAMES} frames a cell, qp20\n`)
  console.log(
    `  ${pad('codec', 22)} ${pad('hw', 10)} ${pad('L1T2 asked', 11)} ${pad('echoed', 8)} ${pad('layers seen', 22)} verdict`,
  )
  for (const r of out.rows) {
    if (r.error) {
      console.log(`  ${pad(r.family, 22)} ${pad(r.hw, 10)} — ${r.error}`)
      continue
    }
    const s = r.svc60 ?? {}
    const asked = s.unsupported ? 'unsupported' : s.error ? 'error' : 'accepted'
    const seen = s.layerCounts ? JSON.stringify(s.layerCounts) : '—'
    const verdict = s.layeredForReal
      ? `LAYERED (${r.baseAlone?.standsAlone ? 'base stands alone' : 'base does NOT stand alone'}${r.baseAlone && r.baseAlone.worstPixelDiff !== undefined ? `, worst pixel diff ${r.baseAlone.worstPixelDiff}/255` : ''})`
      : s.unsupported
        ? 'no'
        : 'accepted but ONE layer'
    console.log(
      `  ${pad(r.codec, 22)} ${pad(r.hw, 10)} ${pad(asked, 11)} ${pad(s.echoedScalabilityMode ?? '—', 8)} ${pad(seen, 22)} ${verdict}`,
    )
    console.log(`      cells measured at ${r.measuredAtFps} fps spacing (${r.rateTries} attempt(s) to find a rate this encoder does not drop)`)
    if (r.costRefused) console.log(`      cost: REFUSED — ${r.costRefused}`)
    if (r.cost) {
      console.log(
        `      cost: the layered file is ${r.cost.svcOverFlat}x the flat one · its base layer is ${Math.round(r.cost.baseShareOfSvc * 100)}% of the bytes`,
      )
      console.log(
        `            selecting the base instead of re-encoding: ${r.cost.baseOverLikeForLike}x like-for-like · ${r.cost.baseOverTodaysExport}x what a half-rate export makes today`,
      )
      console.log(
        `            B/frame — flat ${r.cost.bytesPerFrame.flat} · layered ${r.cost.bytesPerFrame.svc} · base ${r.cost.bytesPerFrame.base} · like-for-like ${r.cost.bytesPerFrame.likeForLike} · today's export ${r.cost.bytesPerFrame.todaysExport}`,
      )
    }
    if (r.baseAlone?.error) console.log(`      base-only decode: ${r.baseAlone.error}`)
  }
  if (SAVE) {
    for (const r of out.rows) {
      if (!r.annexB) continue
      const base = join(SAVE, 'm4-base-30fps.h264')
      const whole = join(SAVE, 'm4-whole-60fps.h264')
      writeFileSync(base, Buffer.from(r.annexB.base, 'base64'))
      writeFileSync(whole, Buffer.from(r.annexB.whole, 'base64'))
      console.log(`\n  gate 2 files (${r.annexB.codec}):`)
      console.log(`    the base layer alone, every enhancement packet dropped: ${base}`)
      console.log(`    the whole layered stream, for comparison:               ${whole}`)
      delete r.annexB
    }
    writeFileSync(OUT, JSON.stringify(out, null, 2))
  }
  const any = out.rows.some((r) => r.svc60?.layeredForReal)
  console.log(`\nm4: ${any ? 'at least one codec really layers — see the cost line' : 'NO codec emitted more than one temporal layer on this machine'}`)
  console.log(`m4: full report ${OUT}`)
} finally {
  if (session) await quitChrome(session).catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  server.close()
}
