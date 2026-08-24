/**
 * EXPERIMENTAL — research harness entry (dev-only page /experimental.html).
 *
 * One button per experiment; each prints a JSON report. This file is the ONLY
 * consumer of the experiment runners; the production entry (src/main.tsx)
 * never references anything under src/experimental/.
 *
 * Automation: `window.__exp.run(id, args?)` exposes every runner (plus the
 * A/V-sync diagnosis runners) to headless-Chromium drivers
 * (src/experimental/tools/cdp-run.mjs) so matrices can run unattended on a
 * throwaway profile per TD hygiene.
 */

interface Runner {
  id: string
  title: string
  detail: string
  run(args?: Record<string, unknown>): Promise<unknown>
}

const runners: Runner[] = [
  {
    id: 'session-log',
    title: 'Experiment 1 — Session Log (shadow mode)',
    detail:
      'observes an unmodified synthetic CaptureSession, appends chained facts to OPFS, folds them, diffs vs the production Recording, and re-folds from disk (replay).',
    run: async () => (await import('../session-log/run')).runShadowSession(4000),
  },
  {
    id: 'oracle',
    title: 'Experiment 2 — Pipeline Oracle (hardened)',
    detail:
      'records a fiducial session, exports twice through the production exporter (full + NON-frame-aligned 1483ms trim), decodes the exports, and reports A/V sync mean+maxAbs with sign, drift, frame flow, and trim accuracy with pass/fail verdicts.',
    run: async (args) => {
      const { runOracle } = await import('../oracle/run')
      return runOracle(
        typeof args?.recordMs === 'number' ? args.recordMs : 6000,
        typeof args?.trimMs === 'number' ? args.trimMs : undefined,
        {
          ...(typeof args?.injectTailLossMs === 'number'
            ? { injectTailLossMs: args.injectTailLossMs }
            : {}),
          // O5-flip A/B lever: `{"composite":false}` restores the pre-O5-flip
          // rig (no live composite alongside), which is how the claim "the
          // composite does not move the sync band" is checked rather than
          // asserted.
          ...(typeof args?.composite === 'boolean' ? { composite: args.composite } : {}),
        },
      )
    },
  },
  {
    id: 'oracle-fidelity',
    title: 'Oracle — audio fidelity (stereo multitone)',
    detail:
      'stereo multitone through measured capture → production export → per-tone level error, THD/IMD, L/R separation, soft-knee hits. Gates: tone ≤1dB, separation ≥40dB, limiterHits=0.',
    run: async (args) => {
      const { runOracleFidelity } = await import('../oracle/fidelityRun')
      return runOracleFidelity(typeof args?.recordMs === 'number' ? args.recordMs : 6000)
    },
  },
  {
    id: 'localize',
    title: 'A/V sync — Step 2/3: capture-vs-compose localization + falsification',
    detail:
      'records a flash+click fiducial session, decodes the RAW channel webms to measure each channel\u2019s first-media time base vs the onstart heuristic, predicts the export sync error from capture bookkeeping alone, exports through production compose, and reports predicted vs measured vs flash cross-check with per-hypothesis outcomes.',
    run: async (args) => {
      const { runLocalization } = await import('../oracle/localize')
      return runLocalization(typeof args?.recordMs === 'number' ? args.recordMs : 6000)
    },
  },
  {
    id: 'matrix',
    title: 'A/V sync — Step 1: characterization matrix',
    detail:
      'oracle across channel mixes (screen+mic / camera+mic / all-four / audio-only) × durations × N runs; reports per-cell mean/max sync offset, drift, trim error, and across-run variance. Long-running.',
    run: async (args) => {
      const { runOracleMatrix } = await import('../oracle/matrix')
      return runOracleMatrix({
        mixes: Array.isArray(args?.mixes) ? (args.mixes as string[]) : undefined,
        durationsMs: Array.isArray(args?.durationsMs) ? (args.durationsMs as number[]) : undefined,
        n: typeof args?.n === 'number' ? args.n : undefined,
        onProgress: (done, total, label) => {
          document.title = `matrix ${done}/${total} ${label}`
        },
      })
    },
  },
  {
    id: 'codecbias',
    title: 'A/V sync — Step 3(c2): codec-chain bias micro-test',
    detail:
      'synthesizes a click track with exactly known positions, encodes via the production toolchain (aac/mp4 + opus/webm), decodes each file via the oracle path (mediabunny) AND via decodeAudioData (playback-representative); disambiguates real mux delay from oracle decode artifact.',
    run: async () => (await import('../oracle/codecbias')).runCodecBias(),
  },
  {
    id: 'armdelay',
    title: 'A/V sync — Step 3(a2): arm-delay falsification',
    detail:
      'localization with streams held live ~2s before recorders start (models production arm→start gap). If audio file t=0 tracks stream creation rather than start(), lag(audio) grows by the delay; if it tracks start(), lag stays put.',
    run: async (args) => {
      const { runLocalization } = await import('../oracle/localize')
      return runLocalization(typeof args?.recordMs === 'number' ? args.recordMs : 6000, {
        armDelayMs: typeof args?.armDelayMs === 'number' ? args.armDelayMs : 2000,
      })
    },
  },
  {
    id: 'sweep',
    title: 'Oracle hygiene — sweep stale exp-oracle-* blobs',
    detail: 'removes production-storage keys stranded by crashed earlier oracle runs.',
    run: async () => {
      const { sweepStaleOracleBlobs } = await import('../oracle/rig')
      return { swept: await sweepStaleOracleBlobs() }
    },
  },
  {
    id: 'recovery',
    title: 'Experiment 3 — Crash-proof sessions',
    detail:
      'journal write/read, durability A/B (createWritable vs SyncAccessHandle+flush with simulated crash), orphan scan, and salvage of a deliberately orphaned webm.',
    run: async () => (await import('../recovery/run')).runRecoveryExperiment(),
  },
  {
    id: 'wcap',
    title: 'Experiment 4 — WebCodecs capture A/B',
    detail:
      'records the same canvas source via MediaRecorder and via MediaStreamTrackProcessor→VideoEncoder→fragmented MP4; compares keyframe cadence, first-packet timestamps, size, and capture cost.',
    run: async () => (await import('../wcap/run')).runWcapExperiment(5000),
  },
  {
    id: 'streamx',
    title: 'Experiment 5 — Streaming export benchmark',
    detail:
      'renders the same 1080p30 composition to BufferTarget (RAM) and StreamTarget (OPFS); compares wall time and JS-heap high-water mark.',
    run: async () => (await import('../streamx/run')).runStreamxBenchmark(20),
  },
  {
    id: 'o1',
    title: 'O1 — export stream-to-disk: memory, parity, orphans',
    detail:
      'drives the PRODUCTION exportRecording over synthetic audio-only takes (waveform render, 1080p30 avc 8 Mbps): peak JS heap per output size for the OPFS-scratch target vs the old BufferTarget, byte-for-byte A/B parity of a short take, and proof that an aborted export leaves no xport-* file behind.',
    run: async (args) => {
      const { runO1Evidence } = await import('../perf/exportMemory')
      return runO1Evidence({
        durationsSec: Array.isArray(args?.durationsSec) ? (args.durationsSec as number[]) : undefined,
        paths: Array.isArray(args?.paths) ? (args.paths as ('scratch' | 'buffer')[]) : undefined,
        includeBuffer: typeof args?.includeBuffer === 'boolean' ? args.includeBuffer : undefined,
        bufferMaxSec: typeof args?.bufferMaxSec === 'number' ? args.bufferMaxSec : undefined,
        shortSec: typeof args?.shortSec === 'number' ? args.shortSec : undefined,
        skipMemory: typeof args?.skipMemory === 'boolean' ? args.skipMemory : undefined,
        skipChecks: typeof args?.skipChecks === 'boolean' ? args.skipChecks : undefined,
      })
    },
  },
  {
    id: 'o2',
    title: 'O2 — capture-time loudness vs the probe pass',
    detail:
      'records takes through the production createCaptureSession (synthetic), compares the makeup gain derived from capture-time stats against the probe pass in dB, times the probe by take length to price what every export used to pay, A/Bs an instant export with and without stats, and proves the stats-less fallback still exports.',
    run: async (args) => {
      const { runO2Evidence } = await import('../perf/captureLoudness')
      return runO2Evidence({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        probeSecs: Array.isArray(args?.probeSecs) ? (args.probeSecs as number[]) : undefined,
      })
    },
  },
  {
    id: 'o3a',
    title: 'O3a — Chromium MP4/H.264 capture',
    detail:
      'reports which MediaRecorder video MIMEs the engine accepts, records takes under each container preference through the production session, demuxes what actually landed on disk, truncates each channel to 60% to prove crash salvage still recovers it, and checks a camera-only take is no longer 720p.',
    run: async (args) => {
      const { runO3aEvidence } = await import('../perf/mp4Capture')
      return runO3aEvidence({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        preferences: Array.isArray(args?.preferences)
          ? (args.preferences as ('auto' | 'mp4' | 'webm')[])
          : undefined,
      })
    },
  },
  {
    id: 'o4step1',
    title: 'O4 step 1 — decompose the residual A/V offset',
    detail:
      'runs the oracle N times and reports, per run, what CI gates on today against the same export measured with both detection biases removed AND both rig references (audio beep arrivals, video flash arrivals) measured rather than assumed. Prices how much of the residual is the instrument.',
    run: async (args) => {
      const { runSyncResidual } = await import('../perf/syncResidual')
      return runSyncResidual({
        runs: typeof args?.runs === 'number' ? args.runs : undefined,
        recordMs: typeof args?.recordMs === 'number' ? args.recordMs : undefined,
      })
    },
  },
  {
    id: 'audiolat',
    title: 'O4b — measured-audio anchor latency (loopback)',
    detail:
      'schedules impulses at exact positions on a source AudioContext clock, runs the stream through the PRODUCTION measured-audio capture path, and reports how far the anchor misplaces them — plus what the platform reports for track/context latency.',
    run: async (args) => {
      const { runAudioLatency } = await import('../perf/audioLatency')
      return runAudioLatency({ seconds: typeof args?.seconds === 'number' ? args.seconds : undefined })
    },
  },
  {
    id: 'armcancel',
    title: 'Regression — cancel a start, leave no device live',
    detail:
      'covers the 2026-08-23 report (stuck on "waiting for microphone", unresponsive, mic indicator still lit after refresh): arming must be cancellable and prompt, a pre-aborted signal must fail before touching a device, and a normal take must still arm and release everything at stop.',
    run: async (args) => {
      const { runArmCancel } = await import('../perf/armCancel')
      return runArmCancel({
        abortAfterMs: typeof args?.abortAfterMs === 'number' ? args.abortAfterMs : undefined,
      })
    },
  },
  {
    id: 'f7',
    title: 'F7 — export quality tiers',
    detail:
      'records a take, exports it at every tier through the same decision EditorScreen makes, and reports estimate-vs-actual size, which path each tier took, whether each file decodes, and whether the choice persists.',
    run: async (args) => {
      const { runQualityTiers } = await import('../perf/qualityTiers')
      return runQualityTiers({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'f1',
    title: 'F1 — mid-take cuts',
    detail:
      'records a fiducial take, exports it with three cuts at non-round offsets, and checks that flash/click sync survives every joint, that the audio has no step discontinuity at a join, and that a no-op segment list is dropped so untouched takes keep the old path.',
    run: async (args) => {
      const { runCutsEvidence } = await import('../perf/cuts')
      return runCutsEvidence({
        recordMs: typeof args?.recordMs === 'number' ? args.recordMs : undefined,
      })
    },
  },
  {
    id: 'o4step2',
    title: 'O4 step 2 — worker/WebCodecs compositor vs the MediaRecorder path',
    detail:
      'drives BOTH live-composite engines from the same synthetic sources at 1080p and 4K, and measures what decides the task: frames that actually reach the file, main-thread long-task time during capture, and the gap between the take length and the last decodable frame (the tail).',
    run: async (args) => {
      const { runCompositorEngine } = await import('../perf/compositorEngine')
      return runCompositorEngine({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        sizes: Array.isArray(args?.sizes) ? (args.sizes as [number, number][]) : undefined,
        engines: Array.isArray(args?.engines) ? (args.engines as ('v1' | 'v2')[]) : undefined,
        rawLane: typeof args?.rawLane === 'boolean' ? args.rawLane : undefined,
        noAudio: typeof args?.noAudio === 'boolean' ? args.noAudio : undefined,
        cold: typeof args?.cold === 'boolean' ? args.cold : undefined,
      })
    },
  },
  {
    id: 'o5',
    title: 'O5 — the export engine: worker + pipelined vs the main-thread render',
    detail:
      'records ONE production-shaped fixture (canvas → MediaRecorder vp9 webm + an opus mic lane), applies an edit with two off-keyframe cuts, and exports it through both engines: the worker with the encode pipelined, and the same render.ts in-thread with its 8-frame yields. Reports output seconds per second of wall clock, main-thread long-task time during each, and a decode probe of both files.',
    run: async (args) => {
      const { runExportEngine } = await import('../perf/exportEngine')
      return runExportEngine({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        content: args?.content === 'motion' ? 'motion' : undefined,
        cuts: typeof args?.cuts === 'boolean' ? args.cuts : undefined,
      })
    },
  },
  {
    id: 'o5cut',
    title: 'O5c — smart cut: copy the composite, re-encode only the boundaries',
    detail:
      'records a real take through createCaptureSession (composite and all), applies a trim-only edit whose boundaries deliberately miss the composite’s 2 s keyframe grid, and exports it both by smart cut and by the full render. Reports wall clock for each, how much of the video was copied rather than re-encoded, and a PSNR comparison of decoded frames at matching output instants — including one 50 ms after the cut, where a decoder-config mismatch would show first.',
    run: async (args) => {
      const { runSmartCut } = await import('../perf/smartCutRun')
      return runSmartCut({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        cutAtFraction: typeof args?.cutAtFraction === 'number' ? args.cutAtFraction : undefined,
      })
    },
  },
  {
    id: 'p0tailraw',
    title: 'P0-tail-raw — does a RAW channel keep its ending?',
    detail:
      'runs a 4K load take with the live composite alongside (as production does) and stops the raw lane four different ways — shipped, a finer timeslice, cutting the track then draining, and throttling the source then draining. Reports the gap between the lane’s length and its last decodable frame for each, plus whether the recorder stops itself when its track ends.',
    run: async (args) => {
      const { runRawTail } = await import('../perf/rawTail')
      return runRawTail({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        size: Array.isArray(args?.size) ? (args.size as [number, number]) : undefined,
        procedures: Array.isArray(args?.procedures)
          ? (args.procedures as ('shipped' | 'slice250' | 'cut' | 'throttle' | 'production' | 'wedged')[])
          : undefined,
        repeats: typeof args?.repeats === 'number' ? args.repeats : undefined,
      })
    },
  },
  {
    id: 'o4worker',
    title: 'O4 — the production worker file driven by the probe feeder',
    detail:
      'crosses the two halves nothing has ever crossed: the UNTOUCHED production compositor.worker.ts driven by the probe’s own feeder and sources, then the engine environment added back piece by piece (bare page → idle AudioContext + ticking tap worklet → full oscillator mix with AudioEncoder). Whichever cell collapses names the wall.',
    run: async (args) => {
      const { runWorkerBisect } = await import('../perf/workerBisect')
      return runWorkerBisect({
        frames: typeof args?.frames === 'number' ? args.frames : undefined,
        width: typeof args?.width === 'number' ? args.width : undefined,
        height: typeof args?.height === 'number' ? args.height : undefined,
        cells: Array.isArray(args?.cells) ? (args.cells as string[]) : undefined,
        warmup: typeof args?.warmup === 'boolean' ? args.warmup : undefined,
      })
    },
  },
  {
    id: 'encprobe',
    title: 'O4 — is WebCodecs the wall, or is our config the wall?',
    detail:
      'feeds the same shape of work the v2 compositor does (paint → VideoFrame → encode, same backpressure ceiling) through a matrix of codec × hardwareAcceleration × latencyMode and measures frames per second OUT. If prefer-hardware and prefer-software land on the same number, nothing is accelerated and the remedy is a config, not a machine.',
    run: async (args) => {
      const { runEncoderProbe } = await import('../perf/encoderProbe')
      return runEncoderProbe({
        frames: typeof args?.frames === 'number' ? args.frames : undefined,
        width: typeof args?.width === 'number' ? args.width : undefined,
        height: typeof args?.height === 'number' ? args.height : undefined,
      })
    },
  },
  {
    id: 'f5a',
    title: 'F5a — silence tightening against a known map',
    detail:
      'builds an audio take whose silences are known to the millisecond (speech bursts over room tone, including one deliberately short gap), runs the production analyser, and reports recall on the long gaps, how much of the proposal lands inside speech, whether the short gap survived, and whether the applied joins click.',
    run: async (args) => {
      const { runSilenceTighten } = await import('../perf/silenceTighten')
      return runSilenceTighten({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'f7c',
    title: 'F7c attempt 4 — is a delta cheaper the closer it is to its keyframe?',
    detail:
      'encodes 180 consecutive frames of screen-like and full-motion content behind ONE keyframe and reports every delta by distance from it. Attempt 3 measured a 15-frame window and predicted files 60 % too small; if delta cost grows with distance, that is the factor of three and the ratio is the correction. If it is flat, the hypothesis is dead.',
    run: async (args) => {
      const { runDeltaGrowth } = await import('../perf/deltaGrowth')
      return runDeltaGrowth({
        width: typeof args?.width === 'number' ? args.width : undefined,
        height: typeof args?.height === 'number' ? args.height : undefined,
        bitrate: typeof args?.bitrate === 'number' ? args.bitrate : undefined,
      })
    },
  },
  {
    id: 'f5b',
    title: 'F5b — per-segment speed',
    detail:
      'speeds a MIDDLE span up and measures what it must not break: the pitch of a known tone in the DECODED export inside the sped stretch (against the same measurement on the unsped export), the oracle’s flash+click sync across both boundaries, the output length against the arithmetic, and what it costs per second of output.',
    run: async (args) => {
      const { runSegmentSpeed } = await import('../perf/segmentSpeed')
      return runSegmentSpeed({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        speed: typeof args?.speed === 'number' ? args.speed : undefined,
      })
    },
  },
  {
    id: 'f2',
    title: 'F2 — timed zoom and pan',
    detail:
      'records a screen+camera take, writes viewport keyframes exactly as the stage commits them, exports, then LOCATES the camera PiP in decoded frames and reads the viewport transform off it. Also checks that the view HOLDS between moves, that a zoomed take loses the packet-copy path, and that an untouched take does not.',
    run: async (args) => {
      const { runZoomPan } = await import('../perf/zoomPan')
      return runZoomPan({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'f3',
    title: 'F3 — background frame',
    detail:
      'exports the same take plain and framed, then LOCATES the screen surface in decoded exported frames and compares it against the pure geometry the editor stage is positioned by. Also checks the unframed default still fills the frame edge to edge, and prices the extra painting.',
    run: async (args) => {
      const { runBackgroundFrame } = await import('../perf/backgroundFrame')
      return runBackgroundFrame({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'o11',
    title: 'O11 — bits audit: where the bytes go, and what each lever is worth',
    detail:
      'records two 1080p sources (a still editor page that scrolls, and a full-frame gradient), renders each through the PRODUCTION exporter across a keyframe-cadence ladder, and demuxes every output file back to count keyframe bytes vs delta bytes. Reports the size delta per cadence with a PSNR against the 2 s default, plus a candidate quality-step ladder for F7b.',
    run: async (args) => {
      const { runBitsAudit } = await import('../perf/bitsAudit')
      return runBitsAudit({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        gops: Array.isArray(args?.gops) ? (args.gops as number[]) : undefined,
      })
    },
  },
  {
    id: 'f4',
    title: 'F4 — movable, timed camera',
    detail:
      'records a screen+camera take, drags the PiP at 2 s and 5 s exactly as the editor does, exports, then LOCATES the PiP in decoded frames and compares it against the pose function — including samples between the drags, which prove the camera holds instead of drifting. Also checks the untouched take still takes the instant path with the PiP in its historical slot.',
    run: async (args) => {
      const { runCameraMove } = await import('../perf/cameraMove')
      return runCameraMove({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'aiexport',
    title: 'AI1 — export for AI: is the file cheap, honest, and immune to the cursor?',
    detail:
      'records real takes (a wandering cursor, a blinking caret, a tooltip, a still minute with a motion burst) through MediaRecorder, builds the PDF with the production builder, then READS THE FILE BACK — JPEGs scanned out of the PDF, the rig’s timecode decoded off the picture — to prove each page shows the frame its caption claims and that no page comes from a cut span. Reports token price, page distribution, pointer-trail precision and build cost against the same take’s full render.',
    run: async (args) => {
      const { runAiExport } = await import('../perf/aiExport')
      return runAiExport({
        economySec: typeof args?.economySec === 'number' ? args.economySec : undefined,
        shortSec: typeof args?.shortSec === 'number' ? args.shortSec : undefined,
        fiducialSec: typeof args?.fiducialSec === 'number' ? args.fiducialSec : undefined,
        includePdf: typeof args?.includePdf === 'boolean' ? args.includePdf : undefined,
        realFile: typeof args?.realFile === 'string' ? args.realFile : undefined,
        realOnly: typeof args?.realOnly === 'boolean' ? args.realOnly : undefined,
      })
    },
  },
  {
    id: 'datachan',
    title: 'Experiment 6 — Timed data channels (live capture demo)',
    detail:
      'records pointer/click/modifier/visibility events against a fresh epoch for 5s (interact with this page!), persists the sidecar, and reports the event stream. Alignment math is covered by unit tests.',
    run: async () => {
      const { startDataChannel } = await import('../datachan/events')
      const rec = startDataChannel(performance.now())
      await new Promise((r) => setTimeout(r, 5000))
      const sidecar = await rec.stop(null)
      const counts: Record<string, number> = {}
      for (const e of sidecar.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
      return { totalEvents: sidecar.events.length, counts, firstTen: sidecar.events.slice(0, 10) }
    },
  },
  {
    id: 'replay',
    title: 'Experiment 1b — replay persisted session logs',
    detail: 'lists .slog.ndjson files in OPFS and re-folds each (crash-prefix tolerant).',
    run: async () => {
      const { listPersistedLogs, replayLog } = await import('../session-log/replay')
      const files = await listPersistedLogs()
      return Promise.all(files.map((f) => replayLog(f)))
    },
  },
]

// Experiments 7 (TimeMap/Scene) and 8 (semantic artifact) are pure modules —
// their evidence is the unit-test suite (npm test), not a browser run.

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.append(...children)
  return node
}

function serialize(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === 'number' && !Number.isInteger(v)) return Math.round((v as number) * 1000) / 1000
      if (v instanceof Float32Array) return `Float32Array(${v.length})`
      return v
    },
    2,
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('harness root missing')

const synthetic = location.search.includes('synthetic')
if (!synthetic) {
  root.append(
    el(
      'p',
      { class: 'fail' },
      'Missing ?synthetic=1 — experiments 1 and 3 will refuse to run (they must not trigger permission prompts). ',
      el('a', { href: '/experimental.html?synthetic=1', style: 'color:#5fbf77' }, 'reload with synthetic mode'),
    ),
  )
}

for (const r of runners) {
  const out = el('pre', { class: 'info' }, 'not run')
  const btn = el('button', {}, `run ${r.id}`)
  btn.addEventListener('click', () => {
    btn.disabled = true
    out.textContent = 'running…'
    out.className = 'info'
    const t0 = performance.now()
    r.run()
      .then((report) => {
        out.textContent = `done in ${Math.round(performance.now() - t0)}ms\n` + serialize(report)
        out.className = 'pass'
      })
      .catch((err: unknown) => {
        out.textContent = String(err instanceof Error ? (err.stack ?? err.message) : err)
        out.className = 'fail'
      })
      .finally(() => {
        btn.disabled = false
      })
  })
  root.append(
    el('section', {}, el('h1', {}, r.title), el('p', {}, r.detail), btn, out),
  )
}

// ---------------------------------------------------------------------------
// Automation API for headless drivers (tools/cdp-run.mjs). Returns plain JSON
// so Runtime.evaluate can move it across the CDP boundary by value.
// ---------------------------------------------------------------------------
interface ExpApi {
  run(id: string, args?: Record<string, unknown>): Promise<string>
}

const expApi: ExpApi = {
  async run(id: string, args?: Record<string, unknown>): Promise<string> {
    const runner = runners.find((r) => r.id === id)
    if (!runner) throw new Error(`unknown experiment "${id}" (have: ${runners.map((r) => r.id).join(', ')})`)
    const report = await runner.run(args)
    return serialize(report)
  },
}
;(window as unknown as { __exp: ExpApi }).__exp = expApi
