# What a crash costs, and how to re-measure it

Task H2, measured 2026-09-01 on the deployed build. This file holds CURRENT truth:
if the numbers move, rewrite the table, do not append a note.

## The bound

**Kill the tab anywhere in a max60 take and you lose at most ~2.1 seconds.** Every
channel comes back, the take is complete up to that point, and it exports.

Five `kill -9` points on Chrome's whole process group, one take each, prod build,
synthetic 1920×1080@60 source, all four channels armed. The take was verified to be
still recording at the instant of the kill (11–371 liveness polls per cell), so every
row prices a crash and not a take that had already stopped.

| killed at | screen | camera | tab audio | mic | worst |
|---|---|---|---|---|---|
| 60 s | 0.90 s | 0.67 s | 1.01 s | 1.01 s | **1.01 s** |
| 5 min | 2.12 s | 0.97 s | 1.17 s | 1.17 s | **2.12 s** |
| 12 min | 1.95 s | 0.76 s | 1.08 s | 1.08 s | **1.95 s** |
| 20 min | 1.47 s | 0.48 s | 0.97 s | 0.97 s | **1.47 s** |
| 31 min | 1.79 s | 1.77 s | 1.44 s | 1.49 s | **1.79 s** |

`N = 2.1 s`, and **it does not grow with the take.** The 31-minute kill loses no more
than the 60-second one — the bound is a property of the write cadence, not of length,
which is the thing this task existed to find out.

The reference is a take **stopped properly** on the same machine: its channels end
0.22–0.24 s behind the stop click. So roughly a quarter-second of the trail above is
what any end-of-take costs, and the crash adds about one to two seconds on top.

## What prices it

Two cadences, one per container, and both are the muxer's — not the disk's. Every
chunk is written AND flushed where the muxer says it goes (`rawVideo.worker.ts`,
`compositor.worker.ts`, and the durable positioned writer behind measured audio), so
nothing is lost between the muxer and the platter. What is lost is what the muxer had
not yet handed over.

- **Video — fragmented MP4, ~1–2 s.** mediabunny closes a fragment only when it is
  already at least `minimumFragmentDuration` long (default 1 s) *and* a keyframe is
  queued on every track. The raw channels use a 2 s GOP (`KEYFRAME_INTERVAL_S`), so a
  fragment closes roughly every 2 s and everything since the last close is still in
  memory when the process dies.
- **Audio — WebM, ~1 s.** The Matroska muxer starts a new cluster once the current one
  is 1 s long (`minimumClusterDuration` default) and flushes the writer after every
  batch, so audio sits about one cluster behind the live moment.

Shortening either would shorten the bound; both cost bytes (more keyframes, more
cluster headers) and neither is worth spending until 2.1 s is the complaint.

## What survives, and what does not

- **The pending manifest survives.** It is the whole hinge — `localStorage`
  `inout.pending`, written at record start — and it was present after all five kills,
  read off disk before the app was allowed to run.
- **Every channel survives.** No kill lost a channel outright at any length.
- **The composite does not, by design.** A crash-truncated composite has an unknown
  tail and must never be packet-copied (2026-08-23), so salvage deletes it. A crashed
  take is its raw channels.
- **The salvaged take exports.** Proven through the product's own buttons, not by
  probing the file: `--export` presses Export on the salvaged take and waits for the
  file to appear in OPFS.
- **The take report card reads INCOMPLETE, honestly.** 3 of 10 dimensions; the other
  seven were evidence that lived in the page and died with it. That is S1's rule
  working — an unread dimension is never a passed one — not a defect in salvage.

## Re-run it

```bash
node scripts/crash-bound.mjs --control=300000 --killAt=60000,300000,720000,1200000,1860000
```

HEAVY: ~80 minutes of headed Chrome. Announce it, and do not run it while the machine
is in use. Exit code is 0 only when all four gates hold (five usable points, every kill
salvaged whole, the manifest survived every time, worst case under 5 s).

Useful flags: `--screen=2560x1440` for a heavier source, `--export` to prove the
salvaged take exports, `--control=<ms>` for the clean-stop reference, `--keep-profile`
to keep the Chrome profile of each cell for inspection.

**Headed on purpose.** Headless Chrome has no GPU here, so the raw channel's WebCodecs
path times out and falls back to MediaRecorder VP9 — a different file with a different
salvage story, and an answer to a question nobody asked.

## The load matters, and 1440p60 is over this machine's line

The first matrix ran a synthetic **2560×1440@60** source and three of its five takes
were dead or dying before the kill arrived — screen delivery falling 44 → 26 → 10 →
0.2 fps, both audio channels ending tens of seconds early. That is not crash loss and
is not reported as any; it is the take collapsing, and the rig's own painter is part of
the reason (a synthetic source is a canvas the page itself paints at 2560×1440 sixty
times a second, which a real screen share does not cost). At 1920×1080@60 the same
take holds 60.0 fps for five minutes and grades GREEN, which is why the bound above is
measured there. See BACKLOG for the one finding that came out of the heavy cells.
