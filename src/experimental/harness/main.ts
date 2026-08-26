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

import { initToneChildIfRequested } from '../perf/toneChild'

// A page opened with &tonechild=1 is the CAPTURED half of the tabaudio rig:
// it renames itself and plays tones on command, and builds no UI of its own.
const isToneChild = initToneChildIfRequested()

interface Runner {
  id: string
  title: string
  detail: string
  run(args?: Record<string, unknown>): Promise<unknown>
}

const runners: Runner[] = [
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
    title: 'Oracle — audio fidelity (stereo multitone, all three export paths)',
    detail:
      'stereo multitone through measured capture → production export → per-tone level error, THD/IMD, L/R separation, soft-knee hits. Render gate: tone ≤1dB, separation ≥40dB, limiterHits=0. Also records a composite-bearing multi-source take and runs the same metrics on the INSTANT packet copy (the file a user actually gets) and on the render of the same take — {"composite":false} skips those lanes (the red proof for their gates).',
    run: async (args) => {
      const { runOracleFidelity } = await import('../oracle/fidelityRun')
      return runOracleFidelity(typeof args?.recordMs === 'number' ? args.recordMs : 6000, {
        ...(typeof args?.composite === 'boolean' ? { composite: args.composite } : {}),
      })
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
        preview: typeof args?.preview === 'boolean' ? args.preview : undefined,
      })
    },
  },
  {
    id: 'o5',
    title: 'O5 — the export engine: worker + pipelined vs the main-thread render',
    detail:
      'records ONE production-shaped fixture (canvas → MediaRecorder vp9 webm + an opus mic lane), applies an edit with two off-keyframe cuts, and exports it through both engines: the worker with the encode pipelined, and the same render.ts in-thread with its 8-frame yields. Reports output seconds per second of wall clock, main-thread long-task time during each, and a decode probe of both files. {"camera":true} adds a SECOND video channel and runs X4’s A/B on top: decode sharded onto one worker per channel against the same render decoding in its own thread.',
    run: async (args) => {
      const { runExportEngine } = await import('../perf/exportEngine')
      return runExportEngine({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        content: args?.content === 'motion' ? 'motion' : undefined,
        cuts: typeof args?.cuts === 'boolean' ? args.cuts : undefined,
        camera: typeof args?.camera === 'boolean' ? args.camera : undefined,
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
    id: 'o4clock',
    title: 'O4-polish — which clock does a captured frame carry?',
    detail:
      "The v2 instant path sits ~25-33 ms above the same take's render, and the suspicion written down with P0-instant-sync is that the composite's two ends are read off different clocks: video frames are stamped when the reader hands them over (arrival), while the file's origin is the first audio batch's capture time. A VideoFrame carries its own timestamp — the capture side of the same event — but in an unspecified epoch. This measures the only honest quantity, arrival − frame.timestamp: its SPREAD is the jitter a media-clock stamp would remove, its SLOPE is the rate error that stamp would introduce over a 900 s take.",
    run: async (args) => {
      const { runFrameClock } = await import('../perf/frameClock')
      return runFrameClock({ takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined })
    },
  },
  {
    id: 'f8',
    title: 'F8 step one — is the editor scrub actually landing on the wrong frame?',
    detail:
      "F8 is written on 'scrub decodes the EXACT frame instead of <video> seek granularity', and nothing in this codebase has ever measured that. This seeks BOTH paths to the same off-grid instants — a <video> element's currentTime, which is what the paused preview does, and the export's own random-access reader — decodes both frames, and reads the rig's painted timecode off each. The answer is in milliseconds of rig clock, and a frame is 33.3 ms.",
    run: async (args) => {
      const { runScrubExact } = await import('../perf/scrubExact')
      return runScrubExact({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        samples: typeof args?.samples === 'number' ? args.samples : undefined,
      })
    },
  },
  {
    id: 'f7c',
    title: 'F7c — what a delta costs, by distance from its keyframe AND by which GOP it is in',
    detail:
      'encodes 180 consecutive frames of screen-like and full-motion content behind ONE keyframe and reports every delta by distance from it (attempt 4), then encodes FOUR consecutive GOPs at the shipped 5 s cadence and compares the first with the rest (attempt 5). The second one is the countable question: the probe only ever measures a file\'s FIRST GOP, and a fresh rate controller ramps.',
    run: async (args) => {
      const { runDeltaGrowth } = await import('../perf/deltaGrowth')
      return runDeltaGrowth({
        width: typeof args?.width === 'number' ? args.width : undefined,
        height: typeof args?.height === 'number' ? args.height : undefined,
        bitrate: typeof args?.bitrate === 'number' ? args.bitrate : undefined,
        series: typeof args?.series === 'boolean' ? args.series : undefined,
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
    id: 'capcheck',
    title: 'O4-polish — does a canvas track honour the display cap production applies?',
    detail:
      'creates a 4K canvas captureStream and applies the SAME constraints capDisplayTrack applies to a real display track, then reads the settings back. Decides whether a production-shaped 4K row can be built from synthetic sources at all — and therefore how tight O8b’s delivered-fps band can be.',
    run: async () => (await import('../perf/rawTail')).runCapCheck(),
  },
  {
    id: 'o10',
    title: 'O10(a) — what do INOUT’s exports actually read in LUFS?',
    detail:
      'records three content shapes (speech-like with pauses, bass-heavy, bright) through a real MediaRecorder, exports each through the real exporter, DECODES the result and runs BS.1770 integrated loudness over the decoded PCM. The shipped makeup normalises a p90 window RMS — unweighted and ungated — and both blind spots are content-dependent, so the number that decides O10(a) is the SPREAD across the three shapes: an offset can be dialled in, a spread cannot.',
    run: async (args) => {
      const { runLoudnessR128 } = await import('../perf/loudnessR128')
      return runLoudnessR128({ takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined })
    },
  },
  {
    id: 'f6',
    title: 'F6 — pause/resume: does the take survive being held, and is the pause left out?',
    detail:
      'records a segment, PAUSES, waits, RESUMES, records a second segment, and stops — all through the real createCaptureSession. Checks by IDENTITY that the same MediaStreamTrack recorded both segments and stayed live while paused (that is what separates a pause from a stop), that segment 2 starts where segment 1 ended (the pause must not appear in the take), that the take is as long as what was recorded rather than as long as the wall clock, and that a paused take still exports.',
    run: async (args) => {
      const { runPauseTake } = await import('../perf/pauseTake')
      return runPauseTake({
        segment1Sec: typeof args?.segment1Sec === 'number' ? args.segment1Sec : undefined,
        pauseSec: typeof args?.pauseSec === 'number' ? args.pauseSec : undefined,
        segment2Sec: typeof args?.segment2Sec === 'number' ? args.segment2Sec : undefined,
      })
    },
  },
  {
    id: 'o9',
    title: 'O9 — where does screen TEXT actually get damaged?',
    detail:
      'probes what this machine’s VideoEncoder will accept for every mode O9 names (AVC 4:4:4, VP9 profile 1, AV1 main and profile 1) per acceleration mode, then measures the damage a glyph takes at EACH of the two encodes in the chain — canvas → raw channel (capture) and raw channel → exported file (export) — against the canvas itself, the only frame nothing has touched. Uses oracle/textEdge.ts, which looks only at glyph edges because a text frame is ~96 % flat background and a whole-frame PSNR is blind to it.',
    run: async (args) => {
      const { runTextPerfect } = await import('../perf/textPerfect')
      return runTextPerfect({ takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined })
    },
  },
  {
    id: 'o4wedge',
    title: 'O4-polish — does a take survive the composite failing, end to end?',
    detail:
      'drives the real createCaptureSession through the two fallback rungs unit tests cannot reach — v2 throwing before its worker exists, and the REAL degrade path firing mid-take — and then exports each take through the product’s own compose/choose.ts ladder. Asserts the path a user would get (instant when the composite is sound, render when it was refused) and that the TAKE is unharmed either way: every raw channel keeps its full length. Injects the trigger, never the consequence.',
    run: async (args) => {
      const { runCompositeWedge } = await import('../perf/compositeWedge')
      return runCompositeWedge({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        cases: Array.isArray(args?.cases)
          ? (args.cases as ('control' | 'startFails' | 'wedged')[])
          : undefined,
      })
    },
  },
  {
    id: 'x6',
    title: 'X6 — a raw channel on WebCodecs against the same channel on MediaRecorder',
    detail:
      'records the SAME take shape twice through the real createCaptureSession — once with the shipped MediaRecorder raw channels, once with X6’s MediaStreamTrackProcessor→AVC→fragmented-MP4 path — and probes both files. Carries O3a’s own gate, the one that refused MP4 capture in the first place: truncate a copy at 50 % of the bytes (which is what a tab kill leaves on disk) and decode it. Reports the tail band, frames, codec and container per channel. CPU is whole-browser and belongs to the sampler: run twice with `--cpu --query=rawcodec=…`.',
    run: async (args) => {
      const { runRawCodecTake } = await import('../perf/rawCodecTake')
      return runRawCodecTake({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        codecs: Array.isArray(args?.codecs)
          ? (args.codecs as ('mediarecorder' | 'webcodecs')[])
          : undefined,
      })
    },
  },
  {
    id: 'x5',
    title: 'X5 — is the render’s 2D composite the readback capture fixed, or a different animal?',
    detail:
      'decodes a screen+camera take into memory FIRST, then composites the same frames through the shipped 2D painter and through the capture GL painter, A/B/B/A warmed. The GL lane includes the per-frame CPU→GPU texture upload the 2D path never pays, and is timed with gl.finish() so the GPU work is inside the measurement rather than left enqueued. Also PSNRs the two painters against each other on the default composition. Answers whether X5’s port is worth writing before the shader for F3/F4/F2 is written.',
    run: async (args) => {
      const { runGlComposite } = await import('../perf/glComposite')
      return runGlComposite({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        frames: typeof args?.frames === 'number' ? args.frames : undefined,
      })
    },
  },
  {
    id: 'x12',
    title: 'X12 — what CAPTURE writes, and what each part of it buys',
    detail:
      'records a production-shaped take (screen 1080p + camera 720p + a mic channel + the live composite through the shipped engine ladder) and WEIGHS every artifact on disk against the take’s own length — the bill, in Mbps and GB/hour, next to the Mbps the delivered file actually carries. Then prices the one rung nobody has priced: the raw SCREEN channel, recorded at 8/6/4/2.5 Mbps off ONE stream at once, each RENDERED through the production exporter, compared by PSNR between those renders. Measurement only; proposes, changes nothing.',
    run: async (args) => {
      const { runCaptureBitrate } = await import('../perf/captureBitrate')
      return runCaptureBitrate({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        contents: Array.isArray(args?.contents)
          ? (args.contents as ('screen' | 'motion')[])
          : undefined,
      })
    },
  },
  {
    id: 'tabaudio',
    title: 'does captured tab audio survive the tab going silent and sounding again?',
    detail:
      'PO 2026-08-26: "maybe audio dies when one youtube video ends and other starts". This page captures ITSELF (preferCurrentTab + the auto-accept testing flag in cdp-run), plays a tone, tears it down like a player, sits silent for the gap, plays a new one — through the production measured-audio path with its mute/ended/silence witnesses. Run with --keep-audio or phase A is vacuous. {"gapSecs":45} sets the silent gap.',
    run: async (args) => {
      const { runTabAudioDeath } = await import('../perf/tabAudioDeath')
      return runTabAudioDeath({
        video1Secs: typeof args?.video1Secs === 'number' ? args.video1Secs : undefined,
        gapSecs: typeof args?.gapSecs === 'number' ? args.gapSecs : undefined,
        video2Secs: typeof args?.video2Secs === 'number' ? args.video2Secs : undefined,
        crossTab: args?.crossTab === true,
      })
    },
  },
  {
    id: 'syncload',
    title: 'A/V sync when the machine is BUSY (PO 4K-game take)',
    detail:
      "records the composite under a saturating CPU+4K-paint load and measures each track's SPAN against the take's wall clock — video is arrival-stamped, audio is sample-counted, so a clock that slips shows up as the two tracks covering different amounts of time. Run {\"load\":false} as the control.",
    run: async (args) => {
      const { runLoadedSync } = await import('../perf/loadedSync')
      return runLoadedSync({
        takeMs: typeof args?.takeMs === 'number' ? args.takeMs : undefined,
        width: typeof args?.width === 'number' ? args.width : undefined,
        height: typeof args?.height === 'number' ? args.height : undefined,
        load: typeof args?.load === 'boolean' ? args.load : undefined,
        engine: args?.engine === 'v1' || args?.engine === 'v2' ? args.engine : undefined,
      })
    },
  },
  {
    id: 'x15a',
    title: 'X15(a) — the bitrateMode sweep X6’s ruling waits on',
    detail:
      'sweeps the raw WebCodecs AVC lane over latencyMode × bitrateMode (including quantizer mode, where the ceiling is ignored) against the SHIPPED MediaRecorder VP9 lane, on screen TEXT with a motion control. Every lane encodes the identical deterministic pictures and is compared by frame ORDINAL, so there is no alignment search and no lower bound — unlike x6, whose 27.9 dB its own rig calls "at least this close". Deliverable: a config that matches the VP9 picture at ≤1.2× its bytes, or the frontier showing none exists.',
    run: async (args) => {
      const { runBitrateModeSweep } = await import('../perf/bitrateModeSweep')
      return runBitrateModeSweep({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        contents: Array.isArray(args?.contents)
          ? (args.contents as ('text' | 'motion')[])
          : undefined,
      })
    },
  },
  {
    id: 'x15b',
    title: 'X15(b) — the 4:4:4 price tag, and a repair of the O9 baseline it is priced against',
    detail:
      'probes every chroma/codec mode O9 names across ALL THREE acceleration modes (O9 stopped at the first yes, so "software only" and "hardware" were one row), then measures glyph-edge damage and UNPACED throughput per mode on identical deterministic text frames. Also re-measures O9’s capture stage against the picture that was actually encoded, next to the same comparison deliberately shifted one scroll step — which is what O9’s own reference was. `{"only":"<id>"}` runs a single encoder so `--cpu` has something it can attribute.',
    run: async (args) => {
      const { runChromaPrice } = await import('../perf/chromaPrice')
      return runChromaPrice({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
        only: typeof args?.only === 'string' ? args.only : undefined,
        repeats: typeof args?.repeats === 'number' ? args.repeats : undefined,
      })
    },
  },
  {
    id: 'x15c',
    title: 'X15(c) — does adding one trim change how a take’s TEXT looks? (BACKLOG P1)',
    detail:
      'records ONE real take of a code-editor screen through the shipped capture session, then exports it three ways through the product’s own ladder — unedited (instant, packet copy of the GL composite), with a tail trim on default flags (smart cut, which copies most packets), and with the SAME trim and smart cut off (render, the 2D painter) — and PSNRs a text region at matching instants with a ±2-frame search. Settles X5’s divergence in production instead of in the lab. Reports; fixes nothing.',
    run: async (args) => {
      const { runTrimTextParity } = await import('../perf/trimTextParity')
      return runTrimTextParity({
        takeSec: typeof args?.takeSec === 'number' ? args.takeSec : undefined,
      })
    },
  },
]

// X3 (PO ruling 2026-08-25, "no standing experimental tree"): the dormant
// research experiments — session log, WebCodecs-capture A/B, streaming-export
// benchmark, timed data channels, TimeMap/Scene, semantic artifact — are gone.
// Their verdicts live in .ai/DECISIONS and their code lives in git history;
// what they proved is in production (wcap became the v2 live composite, streamx
// became O1's stream-to-disk export). Two spent perf rigs went with them: o3a
// (MediaRecorder MP4, REJECTED on evidence) and o4worker (the cold-start
// verdict is in). A rig here is tooling a live task runs, or it is not here.

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

for (const r of isToneChild ? [] : runners) {
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
