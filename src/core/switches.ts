/**
 * EVERY SWITCH THIS PRODUCT READS, IN ONE PLACE — task U4.
 *
 * THE RULING (robert (23), 2026-09-03): "i m sick of this bugs and fucking
 * messes with /?test, something turned on and something not, how to stop this
 * shit" → "make priority task to clean up test switches mess".
 *
 * What was wrong was not the switches, it was that they were INVISIBLE. Each
 * one lived alone in its own module with its own storage key, its own URL
 * parameter and its own default; the panel showed about a dozen of them; and
 * nothing anywhere could answer "what is on right now, and how do I put it
 * back". A switch left on in storage followed him from session to session with
 * no way to see it.
 *
 * So this file is the REGISTRY: one row per switch, naming its URL parameter,
 * its storage key, what it is for in plain words, and what to DO with it. The
 * modules keep their own accessors — this does not read a flag FOR them — but
 * nothing may be readable by the product and absent from here: `switches.test.ts`
 * walks the source with `scripts/switch-census.mjs` and fails on any parameter
 * that has no row, and on any row for a parameter nobody reads.
 *
 * WHAT "CHANGED" MEANS HERE, and it is deliberately not "the value differs from
 * a constant": several defaults are DERIVED (`sourcefps` and `sourceres` follow
 * the quality step; `quality` follows it too), so a registry that carried
 * constants for them would lie the moment the slider moved. A switch is CHANGED
 * when something has been SET for it — a URL parameter on this load, or a value
 * in storage. That is the question Robert is actually asking ("what did I
 * press?"), and it cannot go stale.
 *
 * THE COUNT ONLY GOES DOWN (U4 part 4): `SWITCH_CEILING` below is the number
 * this repo is allowed to carry, and `scripts/build-gate.sh` refuses a push
 * that raises it. Adding a switch means removing one, or asking Robert.
 */

/** How a switch is presented and what its values look like. */
export type SwitchKind =
  | 'toggle' // '1' / '0'
  | 'choice' // one of `options`
  | 'number' // a plain number, unit named in the hint
  | 'list' // a harness list, e.g. `screen:6000,mic:2000`
  | 'text' // free text, e.g. `3024x1964`
  | 'bare' // present or absent; no value

/** Who a switch is for. The panel groups by this, in this order. */
export const SWITCH_GROUPS = ['Recording', 'Picture', 'Sound', 'Export', 'Engine', 'Harness'] as const
export type SwitchGroup = (typeof SWITCH_GROUPS)[number]

export interface SwitchSpec {
  /** The URL parameter, which is also this switch's id everywhere. */
  readonly id: string
  /** localStorage key, or null when the switch lives only in a link. */
  readonly storageKey: string | null
  readonly kind: SwitchKind
  readonly options?: readonly string[]
  /** The resolved default in words, or null when it is derived from something
   *  else (said so in the hint). Shown, never used to decide "changed". */
  readonly fallback: string | null
  readonly group: SwitchGroup
  /** Plain words: what this switch IS. */
  readonly label: string
  /** Plain words: what to DO with it. CLAUDE.md's rule for every panel row. */
  readonly hint: string
  /**
   * A PRODUCT CONTROL that happens to have a URL parameter — the quality
   * slider is the only one today. Its sticky value is what the user chose on
   * the capture screen, so counting it as "changed" would make the state line
   * shout every time he moved the slider. A URL parameter still counts: that
   * is exactly the kind of override that hides.
   */
  readonly product?: true
  /**
   * This switch does NOTHING unless another one is set. The panel greys it out
   * and says so rather than showing a switch that reads as on and is inert —
   * Robert, 2026-08-30, on exactly that: "what the fuck is own res on and
   * native res off, what is difference?".
   */
  readonly needs?: { readonly id: string; readonly value: string }
  /**
   * U4 PART 3 — THE CENSUS AND THE CULL, kept here rather than in a table
   * somewhere that would go stale. Robert's U4 ruling of 2026-09-02 is that
   * every flag becomes a product decision or is deleted; this column is that
   * question answered per switch, and the `answered` ones are the short list he
   * can rule on in one message.
   *
   *   fallback  the FROZEN RULE keeps it: it is the runtime path this product
   *             falls back to, and deleting it deletes the fallback.
   *   harness   an agent needs it to make something fail on purpose. It is not
   *             a product decision and never will be.
   *   product   it IS a product control; the parameter is how a rig sets it.
   *   answered  the question it existed to answer HAS an answer. It can go the
   *             day Robert says which way — nobody else's call.
   */
  readonly verdict: 'fallback' | 'harness' | 'product' | 'answered'
}

/**
 * URL parameters the product reads that are NOT switches. Each needs a reason,
 * because "it is not a switch" is exactly what someone would say about a switch
 * they did not want counted.
 */
export const NOT_SWITCHES: ReadonlyMap<string, string> = new Map([
  ['code', 'the OAuth callback code the cloud provider puts in the URL — not ours to set'],
  ['test', 'the panel switch itself: it is how you SEE the switches, so it cannot be one of them'],
  ['text', 'what Robert typed for `?test`, kept because a panel that does not open is not a panel'],
])

export const SWITCHES: readonly SwitchSpec[] = [
  // ───────────────────────────── Recording ─────────────────────────────
  {
    id: 'nativeres',
    verdict: 'answered',
    storageKey: 'inout.capture.nativeres',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Record at the screen’s size',
    hint: 'Leave on. Off records 1080p whatever your screen is — and makes “Go past 1440p” do nothing.',
  },
  {
    id: 'sourceres',
    verdict: 'product',
    storageKey: 'inout.frame.sourceres',
    kind: 'toggle',
    fallback: null,
    group: 'Recording',
    needs: { id: 'nativeres', value: '1' },
    label: 'Go past 1440p',
    hint: 'Follows the quality slider (on at max) unless you set it. Needs “Record at the screen’s size”.',
  },
  {
    id: 'sourcefps',
    verdict: 'product',
    storageKey: 'inout.frame.rate',
    kind: 'toggle',
    fallback: null,
    group: 'Recording',
    label: '60 fps',
    hint: 'Follows the quality slider (on at max) unless you set it. Set it to record 60 at a lower step.',
  },
  {
    id: 'sourceframe',
    verdict: 'answered',
    storageKey: 'inout.frame.source',
    kind: 'toggle',
    fallback: 'on',
    group: 'Picture',
    label: 'The output takes the take’s own shape',
    hint: 'On: a phone take stays portrait and there are no bars in the file. Off puts the 16:9 frame back.',
  },
  {
    id: 'quality',
    verdict: 'product',
    storageKey: 'inout.capture.quality',
    kind: 'choice',
    options: ['auto', 'max'],
    fallback: null,
    group: 'Recording',
    label: 'Quality mode',
    hint: 'Follows the slider unless you set it. max: nothing steps down and nothing is refused. auto: the rate gives under load and comes back.',
  },
  {
    id: 'qstep',
    verdict: 'product',
    storageKey: 'inout.quality.step',
    kind: 'choice',
    options: ['540p', '720p', '1080p', '1440p', 'max'],
    fallback: '1080p',
    group: 'Recording',
    product: true,
    label: 'Quality step',
    hint: 'The slider on the capture screen. Set it here to start a take at a step without touching the slider.',
  },
  {
    id: 'maxladder',
    verdict: 'answered',
    storageKey: 'inout.capture.maxladder',
    kind: 'toggle',
    fallback: 'off',
    group: 'Recording',
    needs: { id: 'quality', value: 'max' },
    label: 'Rate ladder inside max',
    hint: 'Off by design. On, max trades rate for smoothness instead of dropping frames. Only does anything in max.',
  },
  {
    id: 'resstep',
    verdict: 'fallback',
    storageKey: 'inout.capture.resstep',
    kind: 'toggle',
    fallback: 'off',
    group: 'Recording',
    label: 'Let the ladder drop resolution',
    hint: 'Off: the ladder only gives rate. On to reproduce the 2026-08-29 freeze, where a resolution step made the encoder upscale.',
  },
  {
    id: 'pressure',
    verdict: 'fallback',
    storageKey: 'inout.capture.pressure',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Step down BEFORE frames are lost',
    hint: 'On. Turn off to get the old ladder, which only reacted after delivery had already collapsed.',
  },
  {
    id: 'floor',
    verdict: 'answered',
    storageKey: 'inout.capture.floor',
    kind: 'toggle',
    fallback: 'off',
    group: 'Recording',
    label: 'Emergency floor',
    hint: 'Off. On, a take under extreme load sheds channels to keep writing rather than stopping.',
  },
  {
    id: 'floorres',
    verdict: 'answered',
    storageKey: 'inout.capture.floorres',
    kind: 'toggle',
    fallback: 'off',
    group: 'Recording',
    needs: { id: 'floor', value: '1' },
    label: 'Emergency floor may drop resolution too',
    hint: 'Off. Needs the emergency floor on. Adds a resolution rung to what the floor is allowed to sacrifice.',
  },
  {
    id: 'crashfloor',
    verdict: 'fallback',
    storageKey: 'inout.capture.crashfloor',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'The first second survives a crash',
    hint: 'On. Off restores the old behaviour, where a crash in the first seconds lost the whole take.',
  },
  {
    id: 'burst',
    verdict: 'fallback',
    storageKey: 'inout.capture.burst',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Absorb a burst instead of dropping it',
    hint: 'On. Off drops frames the moment the encoder is behind, which is what the product did before B10.',
  },
  {
    id: 'encoderbudget',
    verdict: 'fallback',
    storageKey: 'inout.capture.encoderbudget',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Refuse a plan this machine has already collapsed under',
    hint: 'On. Off lets a take ask for more encoders than the machine has ever sustained — how the freeze is reproduced.',
  },
  {
    id: 'panel',
    verdict: 'fallback',
    storageKey: null,
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'The on-top recorder window',
    hint: 'On where the browser supports it. `?panel=0` records without the floating window.',
  },
  {
    id: 'bgpace',
    verdict: 'fallback',
    storageKey: 'inout.compose.bgpace',
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Background work gives way to the take',
    hint: 'On. Off lets renders and uploads run at full speed during a recording — use it to see what that costs.',
  },
  {
    id: 'lateness',
    verdict: 'harness',
    storageKey: null,
    kind: 'toggle',
    fallback: 'on',
    group: 'Recording',
    label: 'Measure main-thread lateness',
    hint: 'On. `?lateness=0` switches the sampler off when you are measuring the cost of measuring.',
  },

  // ───────────────────────────── Engine ─────────────────────────────
  {
    id: 'engine',
    verdict: 'fallback',
    storageKey: 'inout.capture.engine',
    kind: 'choice',
    options: ['v1', 'v2'],
    fallback: 'v2',
    group: 'Engine',
    label: 'Composite engine',
    hint: 'v2 is the engine. v1 is the untouched floor kept as the runtime fallback — set it to compare a take against what shipped before.',
  },
  {
    id: 'painter',
    verdict: 'fallback',
    storageKey: 'inout.capture.painter',
    kind: 'choice',
    options: ['webgpu', 'webgl2', '2d'],
    fallback: 'webgpu',
    group: 'Engine',
    label: 'Who paints the composite',
    hint: 'webgpu unless the machine refuses it. Force webgl2 or 2d to see the cost of the rung below.',
  },
  {
    id: 'intake',
    verdict: 'fallback',
    storageKey: 'inout.capture.intake',
    kind: 'choice',
    options: ['auto', 'main', 'worker', 'element'],
    fallback: 'auto',
    group: 'Engine',
    label: 'Where frames come in',
    hint: 'auto probes and picks. Name one to test a rung — `element` is seconds late to its first picture on Chromium (P9).',
  },
  {
    id: 'rawcodec',
    verdict: 'fallback',
    storageKey: 'inout.capture.rawcodec',
    kind: 'choice',
    options: ['webcodecs', 'mediarecorder'],
    fallback: 'webcodecs',
    group: 'Engine',
    label: 'How the raw channels are encoded',
    hint: 'webcodecs. mediarecorder is the pre-O5a path, kept to compare a suspect file against it.',
  },
  {
    id: 'glue',
    verdict: 'fallback',
    storageKey: 'inout.compose.glue',
    kind: 'choice',
    options: ['paint', 'record'],
    fallback: 'paint',
    group: 'Engine',
    label: 'How segments are joined',
    hint: 'paint. record is the older rung — set it when a joined take looks wrong and you need to know which side did it.',
  },
  {
    id: 'singlegen',
    verdict: 'fallback',
    storageKey: 'inout.compose.singlegen',
    kind: 'choice',
    options: ['off', 'export'],
    fallback: 'export',
    group: 'Engine',
    label: 'One generation, not two',
    hint: 'export: the file is made once at export, which is the default. off is the old two-generation path — set it to compare.',
  },

  // ───────────────────────────── Sound ─────────────────────────────
  {
    id: 'audiotap',
    verdict: 'fallback',
    storageKey: 'inout.capture.audiotap',
    kind: 'choice',
    options: ['track', 'worklet'],
    fallback: 'track',
    group: 'Sound',
    label: 'How audio is read off a device',
    hint: 'track. worklet is the old AudioContext path — set it if a device delivers nothing through the track reader.',
  },
  {
    id: 'audiotapthread',
    verdict: 'fallback',
    storageKey: 'inout.capture.audioTapThread',
    kind: 'choice',
    options: ['worker', 'main'],
    fallback: 'worker',
    group: 'Sound',
    label: 'Where the audio reader runs',
    hint: 'worker, off the main thread (X11a). main is every take before it — set it to measure what the move bought.',
  },
  {
    id: 'audiobuf',
    verdict: 'harness',
    storageKey: null,
    kind: 'number',
    fallback: '4000',
    group: 'Sound',
    label: 'Audio read-ahead, ms',
    hint: '4000. `?audiobuf=0` restores the platform default, which is what dropped audio under load before B12.',
  },
  {
    id: 'resamp',
    verdict: 'fallback',
    storageKey: 'inout.export.resamp',
    kind: 'toggle',
    fallback: 'on',
    group: 'Sound',
    label: 'Band-limited resampling',
    hint: 'On. Off uses the cheap resampler — audible as aliasing on tones, which is how the difference is proved.',
  },
  {
    id: 'noisegate',
    verdict: 'answered',
    storageKey: 'inout.compose.noisegate',
    kind: 'choice',
    options: ['off', 'on'],
    fallback: 'off',
    group: 'Sound',
    label: 'Take the steady hiss out',
    hint: 'Off. On removes a steady noise bed from the export only — the recording is never touched. A/B it before it moves.',
  },
  {
    id: 'audiotracks',
    verdict: 'answered',
    storageKey: 'inout.compose.audiotracks',
    kind: 'choice',
    options: ['flat', 'separate'],
    fallback: 'flat',
    group: 'Sound',
    label: 'Mic and computer sound in the file',
    hint: 'flat: one mixed track, exactly as today. separate keeps them apart so a player can mute one (O10b).',
  },
  {
    id: 'loudness',
    verdict: 'answered',
    storageKey: 'inout.export.loudness',
    kind: 'choice',
    options: ['p90', 'r128'],
    fallback: 'p90',
    group: 'Sound',
    label: 'How loud the export is',
    hint: 'p90 is today’s behaviour. r128 is the broadcast standard and is INERT until Robert allows attenuation (O10a).',
  },

  // ───────────────────────────── Export ─────────────────────────────
  {
    id: 'chunked',
    verdict: 'fallback',
    storageKey: 'inout.compose.chunked',
    kind: 'toggle',
    fallback: 'on',
    group: 'Export',
    label: 'The render remembers what it already made',
    hint: 'On. Off renders the whole take again for every edit — 165 s where the remembered path takes 2 s (J1).',
  },
  {
    id: 'bgrender',
    verdict: 'fallback',
    storageKey: 'inout.compose.bgrender',
    kind: 'toggle',
    fallback: 'on',
    group: 'Export',
    label: 'Render an edit while you keep editing',
    hint: 'On. Off waits for the export press before touching the encoder.',
  },
  {
    id: 'prerender',
    verdict: 'answered',
    storageKey: 'inout.export.prerender',
    kind: 'toggle',
    fallback: 'on',
    group: 'Export',
    label: 'Make the file before the press where it is free',
    hint: 'On. Off leaves your machine alone while you edit and pays the whole render at the press.',
  },
  {
    id: 'smartcut',
    verdict: 'fallback',
    storageKey: 'inout.compose.smartcut',
    kind: 'toggle',
    fallback: 'on',
    group: 'Export',
    label: 'Cut without re-encoding what was not cut',
    hint: 'On. Off re-encodes the whole take for a trim — set it when a cut looks wrong and you need the slow, safe path.',
  },
  {
    id: 'colour',
    verdict: 'answered',
    storageKey: 'inout.compose.fullcolour',
    kind: 'choice',
    options: ['420', 'all'],
    fallback: '420',
    group: 'Export',
    label: 'Full colour',
    hint: '420 is today, and it is what to send other people. `all` keeps every colour and a sharp text edge (99.3 % against 77.8 %) — but the file it makes DOES NOT OPEN IN SAFARI, ON AN IPHONE OR ON AN IPAD: measured 2026-09-05, they show a black rectangle, and Safari claims it can play it right up until it cannot. Use `all` for a file you will watch in Chrome yourself.',
  },
  {
    id: 'cq',
    verdict: 'harness',
    storageKey: 'inout.export.cq',
    kind: 'number',
    fallback: 'off',
    group: 'Export',
    label: 'Fixed quality instead of a bitrate',
    hint: 'off. A number 10-40 asks the encoder for that quality and lets the size land where it lands (20 is the default when on).',
  },
  {
    id: 'gop',
    verdict: 'harness',
    storageKey: 'inout.gopSec',
    kind: 'choice',
    options: ['1', '2.5', '5'],
    fallback: '2.5',
    group: 'Export',
    label: 'Seconds between keyframes',
    hint: '2.5. Smaller cuts more precisely and costs size; larger is smaller and coarser at the cut.',
  },

  // ───────────────────────────── Harness ─────────────────────────────
  // Agents only. Every one of these makes something FAIL on purpose, and none
  // is settable from the panel: it is a link you put together for one load.
  {
    id: 'synthetic',
    verdict: 'harness',
    storageKey: null,
    kind: 'bare',
    fallback: 'off',
    group: 'Harness',
    label: 'Fake devices, no permission prompt',
    hint: 'Agents only: `?synthetic=1` records painted screen/camera and a tone, so an e2e run needs no camera and no click.',
  },
  {
    id: 'dead',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'A source that never delivers a frame',
    hint: 'Agents only, with `?synthetic=1`: `?dead=screen` proves the take survives a source that hands over nothing.',
  },
  {
    id: 'die',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'A source that stops mid-take',
    hint: 'Agents only: `?die=camera:8000` ends that channel 8 s in and proves the rest of the take keeps writing.',
  },
  {
    id: 'slow',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'A device that takes its time to arrive',
    hint: 'Agents only: `?slow=mic:6000` delays that channel — measured on prod, 183 ms arm becomes 6079 ms.',
  },
  {
    id: 'quiet',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'A synthetic channel with silence in it',
    hint: 'Agents only: makes a channel deliver silence, which is how the “audio is missing” report is reproduced.',
  },
  {
    id: 'camlies',
    verdict: 'harness',
    storageKey: null,
    kind: 'toggle',
    fallback: 'off',
    group: 'Harness',
    label: 'A camera that reports a size it does not deliver',
    hint: 'Agents only: `?camlies=1` makes the fake camera lie about its resolution, the shape of a real device defect.',
  },
  {
    id: 'killenc',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'The encoder fails on purpose',
    hint: 'Agents only: `?killenc=screen:6000` fails that encoder 6 s in — the containment test (H1).',
  },
  {
    id: 'killworker',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'The encoding worker dies on purpose',
    hint: 'Agents only: `?killworker=screen:6000` kills the worker, which fails harder than the encoder does.',
  },
  {
    id: 'slowstop',
    verdict: 'harness',
    storageKey: null,
    kind: 'list',
    fallback: 'none',
    group: 'Harness',
    label: 'A channel that will not stop promptly',
    hint: 'Agents only: `?slowstop=screen:9000` holds the stop reply back and proves stopping does not hang (H5).',
  },
  {
    id: 'screensize',
    verdict: 'harness',
    storageKey: null,
    kind: 'text',
    fallback: 'the rig default',
    group: 'Harness',
    label: 'Fake screen size',
    hint: 'Agents only, with `?synthetic=1`: `?screensize=3024x1964` reproduces a portrait or 4K take from a link.',
  },
  {
    id: 'camsize',
    verdict: 'harness',
    storageKey: null,
    kind: 'text',
    fallback: 'the rig default',
    group: 'Harness',
    label: 'Fake camera size',
    hint: 'Agents only: `?camsize=1280x720`, the camera half of `?screensize=`.',
  },
  {
    id: 'screenfps',
    verdict: 'harness',
    storageKey: null,
    kind: 'number',
    fallback: 'the rig default',
    group: 'Harness',
    label: 'Fake screen rate',
    hint: 'Agents only: `?screenfps=60`, 1-120. A synthetic take is painted, so this is a request, not a promise.',
  },
  {
    id: 'camfps',
    verdict: 'harness',
    storageKey: null,
    kind: 'number',
    fallback: 'the rig default',
    group: 'Harness',
    label: 'Fake camera rate',
    hint: 'Agents only: `?camfps=30`, the camera half of `?screenfps=`.',
  },
]

/**
 * READS THROUGH A VARIABLE — `p.get(name)`, where the census cannot see the
 * name. Each one is accounted for here by file, and `switches.test.ts` fails on
 * any that is not: a loop over an array of names is exactly how a switch would
 * be added where nobody can see it.
 */
export const DYNAMIC_READS: ReadonlyMap<string, string> = new Map([
  ['src/app/lib/testPanel.ts', 'the panel switch itself, `test` and `text` — both in NOT_SWITCHES'],
  ['src/core/capture/faultInject.ts', 'the three fault knobs, resolved from the FaultKnob union'],
  ['src/core/capture/synthetic.ts', 'parseSizeParam/parseFpsParam, whose four names are rows above'],
  ['src/core/lateness.ts', '`lateness`, the row above (`latebeat` was retired 2026-09-04)'],
])

/**
 * THE CEILING (U4 part 4). The number of switches this repo carries. It may go
 * DOWN in a commit and never up: `scripts/build-gate.sh` compares this against
 * the pushed commit's parent and refuses the push if it rose. Adding a switch
 * means retiring one, or Robert saying so.
 */
export const SWITCH_CEILING = 50

export function switchById(id: string): SwitchSpec | undefined {
  return SWITCHES.find((s) => s.id === id)
}

/* ───────────────────────── reading what is set ───────────────────────── */

export type SwitchSource = 'url' | 'storage' | 'default'

export interface SwitchReading {
  readonly spec: SwitchSpec
  /** The value in the address bar on this load, or null. */
  readonly url: string | null
  /** The value in storage, or null. */
  readonly stored: string | null
  /** Where the value in force comes from. A URL parameter always wins. */
  readonly source: SwitchSource
  /** The value in force, or null when nothing is set and the module decides. */
  readonly value: string | null
}

function urlValue(spec: SwitchSpec, search: string): string | null {
  const p = new URLSearchParams(search)
  if (!p.has(spec.id)) return null
  const v = p.get(spec.id)
  // `?synthetic` and `?dead` with no value are the whole point of a bare switch.
  return v === null || v === '' ? '1' : v
}

function storedValue(spec: SwitchSpec): string | null {
  if (!spec.storageKey) return null
  try {
    return localStorage.getItem(spec.storageKey)
  } catch {
    return null
  }
}

export function readSwitch(spec: SwitchSpec, search: string = currentSearch()): SwitchReading {
  const url = urlValue(spec, search)
  const stored = storedValue(spec)
  const source: SwitchSource = url !== null ? 'url' : stored !== null ? 'storage' : 'default'
  return { spec, url, stored, source, value: url ?? stored }
}

function currentSearch(): string {
  return typeof location === 'undefined' ? '' : location.search
}

/** Every switch, in registry order. */
export function readAllSwitches(search: string = currentSearch()): SwitchReading[] {
  return SWITCHES.map((s) => readSwitch(s, search))
}

/**
 * The ones that are NOT default — something was set for them, here or in a
 * previous session. This is what the state line counts.
 */
export function changedSwitches(search: string = currentSearch()): SwitchReading[] {
  return readAllSwitches(search).filter(
    (r) => (r.spec.product ? r.source === 'url' : r.source !== 'default'),
  )
}

/** "default" or "3 changed" — the always-visible line, in one function so it
 *  cannot say one thing on the capture screen and another in the panel. */
export function switchStateLine(search: string = currentSearch()): string {
  const n = changedSwitches(search).length
  return n === 0 ? 'default' : `${n} changed`
}

/* ───────────────────────── putting it back ───────────────────────── */

/** Clear this switch's sticky value. The URL is not ours to change here. */
export function clearSwitchStorage(spec: SwitchSpec): void {
  if (!spec.storageKey) return
  try {
    localStorage.removeItem(spec.storageKey)
  } catch {
    /* storage unavailable — there was nothing sticky to clear */
  }
}

/** Write a sticky value, or clear it with null. */
export function writeSwitchStorage(spec: SwitchSpec, value: string | null): void {
  if (!spec.storageKey) return
  if (value === null) return clearSwitchStorage(spec)
  try {
    localStorage.setItem(spec.storageKey, value)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** This URL with every switch parameter removed — where RESET navigates. */
export function urlWithoutSwitches(href: string): string {
  const url = new URL(href)
  for (const s of SWITCHES) url.searchParams.delete(s.id)
  return url.pathname + url.search + url.hash
}

/**
 * RESET EVERYTHING: every sticky value gone. Returns the URL the caller must
 * navigate to for the address bar half — storage is cleared here so that the
 * one flag that re-sticks itself from the URL (`sourceframe`) cannot write
 * itself back before the navigation happens.
 */
export function resetAllSwitches(href: string): string {
  for (const s of SWITCHES) clearSwitchStorage(s)
  return urlWithoutSwitches(href)
}
