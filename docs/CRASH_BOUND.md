# What a crash costs, and how to re-measure it

Task H2, measured 2026-09-01 on the deployed build. This file holds CURRENT truth:
if the numbers move, rewrite the table, do not append a note.

## The bound

**Kill the tab anywhere in a running max60 take and you lose at most ~2.1 seconds.**
Every channel comes back, the take is complete up to that point, and it exports. The
exception is the first few seconds of a take, which have their own floor — see below.

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

## The floor: what a crash in the first seconds costs now

Task H2b, measured 2026-09-02 on the deployed build, `?crashfloor=1` (the default).
H2 found this floor and did not fix it; these are the numbers after the two fixes.

| killed at | manifest on disk | what came back | video |
|---|---|---|---|
| 2.3 s | yes (IndexedDB) | **everything** | 2.03 s |
| 3.3 s | yes (IndexedDB) | everything | 2.00 s |
| 4.3 s | yes (IndexedDB) | everything | 4.05 s |
| 5.3 s | yes (IndexedDB) | everything | 4.02 s |
| 7.3 s | yes (IndexedDB) | everything | 6.03 s |
| 8.3 s | yes (IndexedDB) | everything | 8.07 s |
| 10.3 s | yes (IndexedDB) | everything | 10.13 s |
| 20.3 s | yes (IndexedDB) | everything | 20.07 s |

Nothing is unrecoverable at any instant, every channel comes back at every instant,
and the worst channel trail across the eight is 2.14 s — the same bound as the table
above, now true from the second second of a take rather than from the eighth.

**What it was before**, same rig, `?crashfloor=0`, which is still one URL away:

| killed at | manifest on disk | what came back |
|---|---|---|
| 2.8 s | **no** | **nothing — the whole take** |
| 3.3 s | **no** | **nothing** |
| 4.2 s | **no** | **nothing** |
| 5.4 s | localStorage | **audio only** — no video fragment had closed |
| 7.5 s | localStorage | everything, 0.44 s behind |

Two floors, one after the other, and one fix each:

- **The manifest had no commit.** It was written to `localStorage` at record start, and
  Chrome's storage service commits localStorage asynchronously — a `kill -9` inside that
  window took the only pointer to the take's blobs with it, so nothing knew the take had
  existed. It now also goes to its own IndexedDB database with `durability: 'strict'`
  (`recovery.ts`). In the eight cells above the IndexedDB copy survived every kill and
  the localStorage copy survived none, which is the whole finding in one row.
- **No video fragment had closed.** Audio rides ~1 s WebM clusters and already had
  material; a fragmented-MP4 fragment needs its minimum duration AND the next keyframe,
  against a 2 s GOP. One extra keyframe now closes the first fragment at 1 s
  (`EARLY_FRAGMENT_S`). It is ADDED to the GOP grid, never inserted into it — fragments
  close at 1, 2, 4, 6 s where they used to close at 2, 4, 6 — because letting it move
  the grid brings the first fragment a second sooner and every later one a second later,
  which measured WORSE at a 5 s kill (3.0–3.7 s of picture against the shipped 4.0 s).

## Press record into a cold Chrome and none of this applies

Measured 2026-09-02, and it is why `crash-bound.mjs` now waits before pressing record
(`--settleBeforeRecordMs`, default 10 s). Pressing the instant the button appears —
~200 ms after first paint, which no user does — put NOTHING on disk for any video
channel at 2, 3, 4 or 5 s, on the identical build; at 7 s all three files appeared at
once carrying the whole take. A Chrome process's first `VideoEncoder` pays a
multi-second init and the app's own encoder-warm probe is still running at that moment,
so there are no encoded chunks to write and no fragment policy can help. The floor in
that state is Chrome warming up, not salvage. It is a real user state — someone who
presses record a second after the app loads — and it is filed to BACKLOG.

## What prices it

Two cadences, one per container, and both are the muxer's — not the disk's. Every
chunk is written AND flushed where the muxer says it goes (`rawVideo.worker.ts`,
`compositor.worker.ts`, and the durable positioned writer behind measured audio), so
nothing is lost between the muxer and the platter. What is lost is what the muxer had
not yet handed over.

- **Video — fragmented MP4, ~1–2 s.** mediabunny closes a fragment only when it is
  already at least `minimumFragmentDuration` long *and* a keyframe is queued on every
  track. The raw channels use a 2 s GOP (`KEYFRAME_INTERVAL_S`), so a fragment closes
  roughly every 2 s and everything since the last close is still in memory when the
  process dies. H2b adds ONE keyframe at 1 s and halves the minimum so that first
  fragment can close; after it, the cadence is the 2 s it always was.
- **Audio — WebM, ~1 s.** The Matroska muxer starts a new cluster once the current one
  is 1 s long (`minimumClusterDuration` default) and flushes the writer after every
  batch, so audio sits about one cluster behind the live moment.

Shortening either would shorten the bound; both cost bytes (more keyframes, more
cluster headers) and neither is worth spending until 2.1 s is the complaint.

## What survives, and what does not

- **The pending manifest survives.** It is the whole hinge, and since H2b it has two
  homes: `localStorage['inout.pending']` and the `inout-pending` IndexedDB database,
  both written at record start. One of the two was present after every kill in both
  runs, read off disk before the app was allowed to run — through CDP, and
  independently out of the profile's own LevelDB files. In the eight H2b cells the
  IndexedDB copy was the one that survived, every time.
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
is in use. Exit code is 0 only when all five gates hold (five usable points, every kill
salvaged whole, the manifest survived every time, worst case under 5 s, and picture at
every kill point).

The floor is its own, much cheaper run:

```bash
node scripts/crash-bound.mjs --killAt=2000,3000,4000,5000,7000,8000,10000,20000
```

~18 minutes. Add `--url='https://inout-kappa.vercel.app/?crashfloor=0'` for the
positive control — the same eight cells with both fixes off, which is the second table
above.

Useful flags: `--screen=2560x1440` for a heavier source, `--export` to prove the
salvaged take exports, `--control=<ms>` for the clean-stop reference, `--keep-profile`
to keep the Chrome profile of each cell for inspection.

**Headed on purpose.** Headless Chrome has no GPU here, so the raw channel's WebCodecs
path times out and falls back to MediaRecorder VP9 — a different file with a different
salvage story, and an answer to a question nobody asked.

## Do not measure a live take's file by its size

`getFile().size` on a blob a worker is writing through a `SyncAccessHandle` is
STALE — it reads 28 bytes (just the `ftyp`) for the whole take, from inside the page
and from `ls` alike, while the file on disk is megabytes. Cost an hour on 2026-09-02:
polled from the page during a take it said no fragment ever closed, and the same
build's post-kill files had three. **The only honest reading is after the process is
gone**: kill it, then read the files — from OPFS in a fresh page, or straight out of
`<profile>/Default/File System/` with no browser involved, which is what
`crash-bound.mjs`'s manifest read does.

## The load matters, and 1440p60 is over this machine's line

The first matrix ran a synthetic **2560×1440@60** source and three of its five takes
were dead or dying before the kill arrived — screen delivery falling 44 → 26 → 10 →
0.2 fps, both audio channels ending tens of seconds early. That is not crash loss and
is not reported as any; it is the take collapsing, and the rig's own painter is part of
the reason (a synthetic source is a canvas the page itself paints at 2560×1440 sixty
times a second, which a real screen share does not cost). At 1920×1080@60 the same
take holds 60.0 fps for five minutes and grades GREEN, which is why the bound above is
measured there. See BACKLOG for the one finding that came out of the heavy cells.
