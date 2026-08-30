# Every switch in INOUT, and what it is set to

Written 2026-08-29 because Robert had no way to know these existed. This file holds
CURRENT truth — if a default moves, rewrite the row, do not append a note.

Two ways to set any of them:

- **This load only** — add to the URL: `https://inout-kappa.vercel.app/?nativeres=1`
- **Sticky, until you change it** — in the browser console:
  `localStorage.setItem('inout.capture.nativeres', '1')` then reload.

The URL wins over the sticky value; the sticky value wins over the default.

## What is ON by default

| Switch | Turn it off with | What it does |
|---|---|---|
| **Single generation** `?singlegen=` | `?singlegen=off` | On a take with exactly one video channel that is already MP4/AVC at **the geometry of the export step you picked**, the export copies **that channel** instead of the composite (or instead of re-rendering). Keeps colour (80.0 % vs 70.3 %) and is faster, at 14–23 % more bytes. Since O3c (2026-08-29) this follows the SELECTED step — a native-res 1440p screen at the 1440p step is an instant copy, not a re-render; the panel badges such steps "Instant" and their size is the file, exact. |
| **Smart cut** `?smartcut=` | `?smartcut=0` | A trim-only edit copies packets instead of re-encoding — 12.7× faster, and the file is bit-identical to the untrimmed one. |
| **WebCodecs raw channels** `?rawcodec=` | `?rawcodec=mediarecorder` | Raw screen/camera recorded through WebCodecs instead of MediaRecorder. Flipped on your ruling 2026-08-26. 10× less audio-clock starvation, half the bytes at the same picture. |
| **Composite engine v2** `?engine=` | `?engine=v1` | The worker compositor that owns its own encoder. v1 is the old MediaRecorder-on-canvas path. |
| **Native resolution** `?nativeres=` | `?nativeres=0` | Capture the screen at its own size rather than downscaling to 1080p — what makes the 1440p export step real detail instead of an upscale. It went off for part of 2026-08-29 after a game in another tab froze the machine, and came back the same evening on your own words: "i need native resolution and 60 fps work, and not freezing, no turning it off." The waste it used to carry is gone rather than the feature — capture is now bounded at the LARGEST export step (2560 long edge, tied to QUALITY_TIERS by test), so nothing is captured that could never be exported. The freezing half is what `?encoderbudget=` below is for. |
| **All four inputs** | the chips on the capture screen | screen + camera + mic + system audio are all armed by default (`inout.capture.prefs`). |
| **Constant quality** `?cq=` | `?cq=off` | The export targets a QUALITY (H.264 qp20) instead of a bitrate. Measured at 1440p: ~11 % smaller at the same or better picture, on both a still document and a scrolling one. `?cq=18` for finer, `?cq=26` for smaller. Only affects exports that RE-RENDER — an unedited 1080p export copies packets and never encodes. |

| **The frame follows the source** `?sourceframe=` | `?sourceframe=0` | ON, but only where the device cannot capture a screen — i.e. a phone, where the only possible take is camera-only, it is held portrait, and the landscape box the app used to force threw 68 % of the picture away. Everywhere else it is off until you have judged it. Turn it on anywhere with `?sourceframe=1`; **this is the one switch that STICKS when set from the URL**, because it is meant to be flipped on a device with no console. |

## What is OFF by default

| Switch | Turn it on with | What it does, and why it is off |
|---|---|---|
| **Capture-side single generation** `?singlegen=capture` | as written | Stops recording the composite at all — 45–49 % less written per second. Off because it gives up **source-liveness detection** ("your screen froze" stops being noticed). It does NOT cost you preview quality: the preview falls back to the raw `<video>` in the same 16:9 contain-fit box, and measured live on prod it carries ~1.8× the pixels of the compositor's 960×540 canvas, so it is sharper, not softer. Only fires when the one video channel is exactly 1920×1080 — with native resolution on, that is usually false, so on most machines this flag does nothing today. |
| **The rate follows the source** `?sourcefps=` | `?sourcefps=1` | The frame RATE stops being a constant and takes THE SOURCE'S OWN, up to 60. **What a take may attempt is now MEASURED, not assumed** (2026-08-30): the app times its own video encoder once at app load, while nothing is recording, and a take gets 60 fps when its pixels-per-second fit inside that reading. The old rule was a size — 60 above a 2560 long edge was refused — which had an accidental cliff (allowed at 2559, refused at 2561) that a freeze fell straight through, and which refused 60 at exactly the resolution `?sourceres=` exists to deliver. No safety margin is subtracted, because the degradation ladder measures the take as it RUNS and steps the RATE down when the machine turns out busier than it was at load — that is the only thing that can know about a game. Capture stops asking every screen for `max: 30`, both composite engines paint and encode at the take's rate, and the export steps carry it — so a 60 fps game tab or a 60 fps camera records and exports 60 instead of being throttled at the source. It only ever goes UP: a 24 fps webcam still records 30, as it always has. Nothing is REQUESTED — the throttle is lifted, so a source that only offers 30 is unchanged to the byte. Off because F15's own gate says one real 60 fps take is judged by eye before the default moves, and because 60 fps asks the compositor for twice the frames (the degradation ladder watches, and steps resolution down before delivery collapses). A take exports at the rate it was RECORDED at: turning this off does not make an existing 60 fps take export at 30. Costs bytes — twice the frames is close to twice the file at the same picture. |
| **The resolution step** `?resstep=` | `?resstep=1` | Lets the screen's raw recording FOLLOW its source when the source's own size changes mid-take — you change display resolution, or resize the shared window. Today that silently produces the upscaling bug: an encoder is configured once and Chrome scales every later frame back to the size it started at. It works by segmenting, which is F6's pause/resume machinery without the gap: the current file closes and the next opens at the new size on the same track. **This is not a load ladder** — under pressure the frame RATE still moves and resolution never does, which is your own rule. Costs a stepped take its own-resolution export (two segments, two geometries, nothing to packet-copy as one file); the normal instant export is unaffected because that copies the composite, which stays one size throughout. Off because it changes the files a take produces. |
| **Your own resolution** `?sourceres=` | `?sourceres=1` | **Does nothing at all unless `?nativeres=` is on** — with native-res capture off the constraint is the flat 1080p cap and this switch is never consulted, so a take can carry a settings line claiming it while its screen channel is 1080p (found 2026-08-30, from Robert's own screenshot; the panel now greys it out and the badge marks it INERT). Otherwise: adds a **Source** export step that is your screen's own long edge — 3024×1964 instead of stopping at 1440p — and lifts the capture ceiling to match, because they are one constant. Delivered by the packet copy, so it is instant and never re-encoded. It appears only on a **screen-only** take bigger than 1440p: the composite is written at 1920 whatever the screen was, so a screen+camera take has nothing that holds your resolution. **It also stops the composite being recorded at all on those takes** (2026-08-30): at native resolution the composite is not a different picture, it is a smaller copy of this one made by a second hardware encoder — and that second encoder is the difference between 481 Mpx/s and 356 on a 3024×1964 60 fps take, i.e. between impossible and merely hard. The cost is the one `?singlegen=capture` always carried: no source-liveness detection ("your screen froze" stops being noticed), the raw preview replaces the composited one (measurably sharper, not softer), and an export at a step SMALLER than the take re-renders instead of copying. |
| **The encoder budget** `?encoderbudget=` | `?encoderbudget=1` | Bounds the SCREEN's capture size at arm time, before any encoder opens, so a take cannot ask for more encoding than this machine has been seen to survive. A screen+camera take opens THREE encoders — raw screen, raw camera, composite — and until O15 nothing added them up. **It is not a constant**: a machine that has never been seen to collapse has no budget at all and nothing changes. The bound comes only from this machine's own history — a take that ran clean raises what it may attempt, a rate-ladder step or a composite giving up lowers it, and a take that worked outranks an older one that did not. Off because it changes what gets recorded on a machine with a collapse in its history; the measurement and the console line run either way, so your machine already knows its own numbers before you ever turn this on. |
| **R128 loudness** `?loudness=` | `?loudness=r128` | Broadcast −14 LUFS normalization instead of the shipped p90 bounding. Off because R128 can only hit the target by turning takes **down**, and the shipped rule never attenuates. |


## Quality modes

| Switch | Example | What it does |
|---|---|---|
| **Capture quality** `?quality=` | `?quality=max` | **`auto` (default)** — the machine is protected from the take: the rate ladder steps the frame RATE down under load and puts it back as the machine eases, a rate your encoder measured itself unable to sustain is not attempted, and (with `?encoderbudget=1`) a machine with a collapse in its history is bounded before anything opens. The SIZE never moves. **`max`** — nothing steps down and nothing is refused: your source's own resolution and rate, for the whole take. **There is no ladder in max** (it is reachable with `?maxladder=1`, off by default). Max is made to work by opening FEWER ENCODERS rather than by throttling: at native resolution the composite is not recorded at all, because it is a downscaled second copy of a picture the raw channels already hold. With more than one video channel there is then nothing to packet-copy, so the unedited export RENDERS — the price of max, paid at export time where a wait costs only time, rather than during capture where it costs the picture. Source-liveness detection and the composited preview are off with it. |

## Test-only (do not use on a real take)

| Switch | Example | What it does |
|---|---|---|
| `?synthetic=1` | | Fake devices — no permission prompts. This is how agents drive the app. |
| `?slow=` | `?synthetic=1&slow=mic:6000` | Delays a channel's arm, to reproduce a stuck arm without hardware. |
| `?quiet=` | `?synthetic=1&quiet=0.05` | Scales the synthetic audio down. |
| `?camsize=` | `?synthetic=1&camsize=1080x1920` | The synthetic camera's size — how a PORTRAIT take is reproduced without a phone (default 640×480). |
| `?camlies=1` | `?synthetic=1&sourceframe=1&camsize=1080x1920&camlies=1` | Makes the synthetic camera report its dimensions **transposed** — the one lie a real phone tells (`getSettings()` describes the sensor, the frames arrive rotated). This is how the phone bug is reproduced on a desktop. |
| `?screensize=` | `?synthetic=1&screensize=3840x2160` | The synthetic screen's size (default 1280×720). |
| `?screenfps=` `?camfps=` | `?synthetic=1&sourcefps=1&screenfps=60` | The synthetic screen's / camera's rate (default 30, max 120) — how a **60 fps source** is put in front of the product without a 120 Hz monitor or a 60 fps sensor. |

## Not a URL flag — it is in the UI

| Setting | Where | Default |
|---|---|---|
| Export quality step | the quality panel before export | **1080p** (`inout.export.tier`) |

1080p keeps the instant packet copy of the composite. Since O3c (2026-08-29),
**a step that matches your screen's own geometry is ALSO instant** — it copies
the raw channel (screen-only takes; the panel badges it "Instant" and its size
is exact). Every other step re-encodes the whole take, which is why those are
slow and much bigger — see the export-size entry in `BACKLOG.md`.

## Sticky keys, for clearing

```
inout.capture.prefs       inout.capture.engine      inout.capture.nativeres
inout.capture.rawcodec    inout.compose.singlegen   inout.compose.smartcut
inout.export.loudness     inout.export.tier          inout.export.cq
inout.frame.source        inout.frame.rate
```

Clear them all: `Object.keys(localStorage).filter(k=>k.startsWith('inout.')).forEach(k=>localStorage.removeItem(k))`
