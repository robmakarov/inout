# The take report card — a verdict off Robert's machine (S1, 2026-09-01)
Purpose: every take grades itself AT STOP against the black box it already carries; the verdict is one line, recomputed on demand for any take still on the machine. Nothing is sampled while the recorder runs. Robert's daily recording is the soak fleet: a column of GREEN/RED with the failing dimension named.

## Read it — ask Robert for nothing
Open https://inout-kappa.vercel.app on his machine; the globals are in every build, next to `__inoutSupport` (`src/main.tsx`):
```js
await __inoutReport()                // the newest take's card
await __inoutReport('rec_xyz')       // that take
await __inoutReportAll()             // every take still on this machine, newest first
await __inoutTakeLog()               // the verdict LINE of every take, including deleted ones
await __inoutReport(recordingObject) // grades a pasted object without storing it — re-grade a historical black box quoted in a task or docblock
```
- `__inoutTakeLog()` is the fleet: a ring of the last 60 takes in `localStorage['inout.takeReport.v1']`, written as each take stops, so it outlives the recordings (`core/report/takeJournal.ts`). Everything else is recomputed from IndexedDB — a card is never stale.

## The verdict
| verdict | means |
|---|---|
| `green` | every dimension measured and inside its band |
| `red` | at least one dimension failed — `line` names it, with its numbers |
| `incomplete` | nothing failed, but something could not be measured — NOT a soft pass (R1's ruling, generalised: an unread dimension is not a passed one): a take recorded before a witness existed, an Apple WebKit take whose audio lane counts no silence, a card built without the wedge journal. The line says which |

## The ten dimensions — bands and their reasons live in `src/core/report/reportCard.ts`; each detail line quotes what it measured, so a stricter gate (A1's `silentTailMs < 1 s`) is readable off a card that passed
| id | fails when | read off |
|---|---|---|
| `channels` | a requested channel never arrived, or one ended early | `missing`, per-channel length |
| `audio-continuity` | pure digital zeros ≥ 10 s AND ≥ 5 % of the channel | `silentTailMs` |
| `audio-clock` | inserted/removed silence ≥ 1 % of the channel | `paddedMs`, `trimmedMs` |
| `rescue` | the dead-tap revival fired after the first 60 s | `events`, regrouped into runs |
| `picture` | a video source froze mid-take | `stalled` |
| `rate` | the take gave something up to keep up | `stopStats.degradedWhy` |
| `sync` | a channel carries no B7 anchor while others do | `diagnostics.anchor` |
| `storage` | it ended with under 2 min of headroom at its own write rate | `stopStats` storage + bytes |
| `memory` | heap at stop ≥ 70 % of the engine's limit | `stopStats.heapBytes` |
| `wedges` | a wedge or main-thread block landed inside the take's window | `inout.wedgeJournal.v1` |

## What the card deliberately does NOT claim
- Memory is a point sample at stop, not a high-water mark. Nothing samples during a take and nothing should — the hour-scale slope is task H3 (docs/MEMORY_SLOPE.md).
- Revive bursts are RUNS, not attempts: "25 attempts" says nothing, six separate deaths convict the ladder. The regrouping uses `reviveSchedule.ts`'s own arithmetic (the gap to the next attempt equals the age of the silent run, capped at the ceiling). It cannot separate a new run that begins exactly one ceiling-length after the last attempt of a run already at the ceiling — the black box holds nothing that could — and merging understates the count rather than inventing one.

## The fixture — the take this was built to convict
`rec_78ogcw052vdn` — 50.4 min, quality=max, camera + mic + tab audio — grades RED: `audio-continuity: tab audio went to digital zeros 22.9 min in and never came back — 27.5 min of 50.4 min (54.5%)` · `rescue: tab audio 6 revive bursts (25 attempts), 5 after warm-up — runs began 0.2s, 189.4s, 455.1s, 707.7s, 1328.4s, 1376.3s`. `audio-clock` PASSES on the same take (5,647 ms of padding across 3,026 s = the wall-clock hold working): the audio clock was not starving, the input was — the finding A1 starts from. Pinned in `src/core/report/reportCard.test.ts`: if the card cannot convict it, it cannot convict anything.
