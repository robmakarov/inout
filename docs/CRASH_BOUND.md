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

## The first take after a Chrome launch, and only that one

Task H6, measured 2026-09-02. **A Chrome PROCESS's first `VideoEncoder` costs about
3.2 seconds**, and until it is paid nothing encoded exists anywhere, so a take that
starts inside that window has no picture on disk to salvage. It is not the fragment
cadence and not salvage; it is the machine waking up.

It is a process cost, not a size one, and not the app's chunks:

| measured on prod | |
|---|---|
| first encoder, 1920×1080 | `isConfigSupported` 67 ms · init + 5 frames + flush **3122 ms** |
| first encoder, 640×360 | 71 ms · **3276 ms** |
| first encoder, 320×240 | 147 ms · **3281 ms** |
| *second* encoder, same process | 0 ms · **47–77 ms** |
| the warm's own chunks | 585→708 ms cold cache, 288→372 ms warm |

So the warm cannot be made cheaper and cannot start earlier than the mount it already
starts at. **What it could do was stop competing.** With nobody recording it finished
4.2 s after page start; press record the moment the app is usable and it finished at
5.0–8.6 s instead, because the take's three encoders and the warm's two were fighting
over the same hardware. H6 closes the warm's init encoder the instant its flush
resolves, and stands its 40-frame measurement down when a take commits — deferred, not
lost: `doStop` runs it when the take ends, with nothing recording.

**What that is worth, same rig, `--settleBeforeRecordMs=0`:**

| killed at | before H6 | after H6 |
|---|---|---|
| 2 s | no picture | no picture |
| 3 s | no picture | no picture |
| 4 s | no picture | **3.00 s of picture** |
| 5 s | no picture | **4.53 s** |
| 7 s | everything, all at once | — |

**And on any page load after the first, there is no window at all.** The 3.2 s is paid
once per Chrome LAUNCH, not per load: on the second and third loads in the same Chrome
the whole warm — chunks, init and measurement — finishes **577–618 ms after page
start**, before anyone can reach the button. Verified end to end: an already-running
Chrome, a fresh load, record pressed at once, killed at 2 s → two of three video files
hold a closed fragment with **1.0 s of picture**, the same as a settled app.

So the residual is exactly one case: the first page INOUT is asked for after a browser
launch, where a crash in the first ~4 s still costs the picture. That is Chrome's GPU
process starting, measured at 3.1–3.3 s whatever we ask of it.

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
