# AI export — spec

Status: agreed 2026-08-24, not built. A second export target next to the MP4:
capture → … → **agent bundle** → share.

Agents don't watch video — they sample frames and pay tokens per frame. A recording is
useful to an agent only if it is agent-legible and cheap to ingest. inout's structural
edge: it is a browser recorder, so it can capture the DOM events behind the pixels,
which no generic screen recorder can.

## Design law: no knobs

Every parameter a human would set is either **derived from a signal already in the
recording**, or **both layers ship and the agent's reading order decides**. Controls
exist only where neither works. In one line:

> The recorder captures everything, the export adapts from signals, and the agent pulls.

| knob you'd be tempted to add | the signal that replaces it |
|---|---|
| frame rate | pixel delta — dense frames during motion bursts (animation), near zero when static |
| resolution | event location — low-res full view + full-res crop around the click/changed region |
| chunk length | activity boundaries — URL change, long idle gap |
| small bundle vs complete bundle | layering — cost scales with how deep the agent descends |
| record quality | none — always capture max, derive everything down at export |

## In scope

### 1. Event sidecar

Written during recording, timestamped against the video clock. JSONL, one event per line:

- `click` — t, x, y, target selector, visible text
- `key` — t, character count only; never contents in password/sensitive fields
- `scroll` — t, position
- `nav` — t, URL / tab change
- `focus` — t, window/tab focus change

A 5-minute video is thousands of frames; the sidecar is a few hundred tokens that tell
the agent what happened, so it looks at pixels only where it must.

### 2. "For AI" export

One button. Produces a folder, not an mp4 — layered so reading cost scales with descent.
The agent's own laziness is the frames-control we didn't build:

```
export/
  INDEX.md        what this is, duration, segment list, file map — read first, tiny
  events.jsonl    the sidecar
  transcript…     (deferred — slot reserved)
  keyframes/      pixel-delta sampled; per frame: low-res full view + full-res event crop;
                  timestamp in filename
  bursts/         dense sequences auto-detected during sustained high delta, fps labeled
  video.*         full fidelity, bottom of the stack
```

Segmentation by activity boundaries, never fixed durations. Works as a plain folder —
agents (Claude Code etc.) read the index and descend; no server, no API required.

## Deferred, not rejected

Named so they don't get reinvented from scratch: voice transcript with timecodes
(VTT; silence/filler auto-stripped, original timestamps kept), marker key during
recording, repro bundle (console errors + failed requests timestamped against video),
addressable recordings / MCP server, PII redaction in the export.
