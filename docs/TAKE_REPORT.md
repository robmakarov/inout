# The take report card — a verdict off Robert's machine (S1, 2026-09-01)
Purpose: every take grades itself AT STOP against the black box it already carries; the verdict is one line, recomputed on demand for any take still on the machine. Robert's daily recording is the soak fleet: a column of GREEN/RED with the failing dimension named. ONE dimension samples while the recorder runs — `lateness` (G7), because "how late did the main thread run" cannot be derived from anything a take already holds; it costs a measured fraction of a millisecond per second and carries that measurement on the card. Everything else still samples nothing.

## Read it — ask Robert for nothing
Open https://inout-kappa.vercel.app on his machine; the globals are in every build, next to `__inoutSupport` (`src/main.tsx`):
```js
await __inoutReport()                // the newest take's card
await __inoutReport('rec_xyz')       // that take
await __inoutReportAll()             // every take still on this machine, newest first
await __inoutTakeLog()               // the verdict LINE of every take, including deleted ones
await __inoutReport(recordingObject) // grades a pasted object without storing it — re-grade a historical black box quoted in a task or docblock
await __inoutEditorReport()          // G7: the editor's own first 15 s, graded against the same band
await __inoutLateness(5000)          // G7: sample THIS thread for 5 s wherever you are standing
```
- `__inoutTakeLog()` is the fleet: a ring of the last 60 takes in `localStorage['inout.takeReport.v1']`, written as each take stops, so it outlives the recordings (`core/report/takeJournal.ts`). Everything else is recomputed from IndexedDB — a card is never stale.

## The verdict
| verdict | means |
|---|---|
| `green` | every dimension measured and inside its band |
| `red` | at least one dimension failed — `line` names it, with its numbers |
| `incomplete` | nothing failed, but something could not be measured — NOT a soft pass (R1's ruling, generalised: an unread dimension is not a passed one): a take recorded before a witness existed, an Apple WebKit take whose audio lane counts no silence, a card built without the wedge journal. The line says which |

## The twelve dimensions — bands and their reasons live in `src/core/report/reportCard.ts`; each detail line quotes what it measured, so a stricter gate (A1's `silentTailMs < 1 s`) is readable off a card that passed
| id | fails when | read off |
|---|---|---|
| `channels` | a requested channel never arrived, or one ended early | `missing`, per-channel length |
| `audio-continuity` | pure digital zeros ≥ 10 s AND ≥ 5 % of the channel | `silentTailMs` |
| `audio-clock` | inserted/removed silence ≥ 1 % of the channel | `paddedMs`, `trimmedMs` |
| `rescue` | the dead-tap revival fired after the first 60 s | `events`, regrouped into runs |
| `picture` | a video source froze mid-take | `stalled` |
| `rate` | the take gave something up to keep up | `stopStats.degradedWhy` |
| `elastic` | a PICTURE step was taken while the unseen work was still running — the order of defence, violated (E2). NOT a failure: shedding and recovering, or ending a take still shed. The detail line carries the whole ledger's shape and how long the picture took to come back | `stopStats.elastic` (core/elasticLog.ts `auditElastic`) |
| `sync` | a channel carries no B7 anchor while others do | `diagnostics.anchor` |
| `storage` | it ended with under 2 min of headroom at its own write rate | `stopStats` storage + bytes |
| `memory` | heap at stop ≥ 70 % of the engine's limit | `stopStats.heapBytes` |
| `lateness` | the worst ONE-SECOND window of main-thread lateness exceeded 30 ms — Phase 1's own claim ("no editor stall > 30 ms"), so the card and the claim are one number (G7). Graded on the window, not on a single sample: at 60 samples a second an hour-long take takes 216,000 of them and something is over any threshold eventually. The strict "> 1 frame late is a defect" reading stays in the detail as `overFrame` | `stopStats.lateness` (core/lateness.ts) |
| `wedges` | a wedge or main-thread block landed inside the take's window | `inout.wedgeJournal.v1` |

## What the card deliberately does NOT claim
- **Lateness is measured to within one sampling period (16 ms), and it is the MAIN thread's.** A stall that starts halfway through a period is reported that much shorter, so a 35 ms stall can read as low as 19 — quote `periodMs`, which every summary carries. It is not a frame-loss signal: the recorder's own work is in workers (the encoders, the compositor, the muxers), and E1's `worker-lateness` is what steps the ladder. What lives on the main thread is the tick, the preview, the audio taps and the store, so this is the dimension B12 is argued from.
- **Its percentiles are bucket-interpolated, never exact.** Exact order statistics over an hour at 60 Hz would mean keeping 216,000 numbers alive inside a take. The MAX is exact — a defect is argued from the worst sample, and an estimate of it would not be worth having.
- **A take has no task attribution and that is not a gap.** Neither `long-animation-frame` nor `longtask` reports on a hidden document (E1 measured 0 entries in 74 s), and a take is hidden for essentially its whole length. Attribution is a thing the EDITOR's card has. The take's card says so in words rather than leaving an empty field.
- Memory is a point sample at stop, not a high-water mark. Nothing samples during a take and nothing should — the hour-scale slope is task H3 (docs/MEMORY_SLOPE.md).
- Revive bursts are RUNS, not attempts: "25 attempts" says nothing, six separate deaths convict the ladder. The regrouping uses `reviveSchedule.ts`'s own arithmetic (the gap to the next attempt equals the age of the silent run, capped at the ceiling). It cannot separate a new run that begins exactly one ceiling-length after the last attempt of a run already at the ceiling — the black box holds nothing that could — and merging understates the count rather than inventing one.

## The fixture — the take this was built to convict
`rec_78ogcw052vdn` — 50.4 min, quality=max, camera + mic + tab audio — grades RED: `audio-continuity: tab audio went to digital zeros 22.9 min in and never came back — 27.5 min of 50.4 min (54.5%)` · `rescue: tab audio 6 revive bursts (25 attempts), 5 after warm-up — runs began 0.2s, 189.4s, 455.1s, 707.7s, 1328.4s, 1376.3s`. `audio-clock` PASSES on the same take (5,647 ms of padding across 3,026 s = the wall-clock hold working): the audio clock was not starving, the input was — the finding A1 starts from. Pinned in `src/core/report/reportCard.test.ts`: if the card cannot convict it, it cannot convict anything.
