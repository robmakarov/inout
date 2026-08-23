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
