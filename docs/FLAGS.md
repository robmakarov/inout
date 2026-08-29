# Every switch in INOUT, and what it is set to

Written 2026-08-29 because PO had no way to know these existed. This file holds
CURRENT truth — if a default moves, rewrite the row, do not append a note.

Two ways to set any of them:

- **This load only** — add to the URL: `https://inout-kappa.vercel.app/?nativeres=1`
- **Sticky, until you change it** — in the browser console:
  `localStorage.setItem('inout.capture.nativeres', '1')` then reload.

The URL wins over the sticky value; the sticky value wins over the default.

## What is ON by default

| Switch | Turn it off with | What it does |
|---|---|---|
| **Single generation** `?singlegen=` | `?singlegen=off` | On a take with exactly one video channel that is already MP4/AVC at exactly 1920×1080, the export copies **that channel** instead of the composite. Keeps colour (80.0 % vs 70.3 %) and is faster, at 14–23 % more bytes. |
| **Smart cut** `?smartcut=` | `?smartcut=0` | A trim-only edit copies packets instead of re-encoding — 12.7× faster, and the file is bit-identical to the untrimmed one. |
| **WebCodecs raw channels** `?rawcodec=` | `?rawcodec=mediarecorder` | Raw screen/camera recorded through WebCodecs instead of MediaRecorder. Flipped on your ruling 2026-08-26. 10× less audio-clock starvation, half the bytes at the same picture. |
| **Composite engine v2** `?engine=` | `?engine=v1` | The worker compositor that owns its own encoder. v1 is the old MediaRecorder-on-canvas path. |
| **All four inputs** | the chips on the capture screen | screen + camera + mic + system audio are all armed by default (`inout.capture.prefs`). |
| **Constant quality** `?cq=` | `?cq=off` | The export targets a QUALITY (H.264 qp20) instead of a bitrate. Measured at 1440p: ~11 % smaller at the same or better picture, on both a still document and a scrolling one. `?cq=18` for finer, `?cq=26` for smaller. Only affects exports that RE-RENDER — an unedited 1080p export copies packets and never encodes. |
| **Native resolution** `?nativeres=` | `?nativeres=0` | Capture the screen at ITS OWN size instead of downscaling to 1080p. On since 2026-08-29 on PO's ruling. This is what makes the 1440p export step real detail instead of an upscale. If a big screen ever freezes a take again, this is the switch to turn off — and say so. |

## What is OFF by default

| Switch | Turn it on with | What it does, and why it is off |
|---|---|---|
| **Capture-side single generation** `?singlegen=capture` | as written | Stops recording the composite at all — 45–49 % less written per second. Off because it gives up source-liveness detection and the composited preview. |
| **R128 loudness** `?loudness=` | `?loudness=r128` | Broadcast −14 LUFS normalization instead of the shipped p90 bounding. Off because R128 can only hit the target by turning takes **down**, and the shipped rule never attenuates. |

## Test-only (do not use on a real take)

| Switch | Example | What it does |
|---|---|---|
| `?synthetic=1` | | Fake devices — no permission prompts. This is how agents drive the app. |
| `?slow=` | `?synthetic=1&slow=mic:6000` | Delays a channel's arm, to reproduce a stuck arm without hardware. |
| `?quiet=` | `?synthetic=1&quiet=0.05` | Scales the synthetic audio down. |

## Not a URL flag — it is in the UI

| Setting | Where | Default |
|---|---|---|
| Export quality step | the quality panel before export | **1080p** (`inout.export.tier`) |

1080p is the only step that keeps the instant packet copy. **Every other step
re-encodes the whole take**, which is why they are slow and much bigger — see
the export-size entry in `BACKLOG.md`.

## Sticky keys, for clearing

```
inout.capture.prefs       inout.capture.engine      inout.capture.nativeres
inout.capture.rawcodec    inout.compose.singlegen   inout.compose.smartcut
inout.export.loudness     inout.export.tier          inout.export.cq
```

Clear them all: `Object.keys(localStorage).filter(k=>k.startsWith('inout.')).forEach(k=>localStorage.removeItem(k))`
