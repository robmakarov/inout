# The take report card — reading a verdict off Robert's machine

**What it is (task S1, 2026-09-01):** every take grades itself against the black box it
already carries, and the verdict is one line. Nothing is sampled while the recorder runs —
the card is computed AT STOP, and recomputed on demand for any take still on the machine.
Robert's ordinary daily recording is the soak fleet this product never had: `unlimited
length, perfect` stops being argued and becomes a column of GREEN/RED with the failing
dimension named.

## Read it — ask Robert for nothing

Open the app (https://inout-kappa.vercel.app) on his machine and run one expression. The
globals are in every build, next to `__inoutSupport` (`src/main.tsx`).

```js
await __inoutReport()            // the newest take's card
await __inoutReport('rec_xyz')   // that take
await __inoutReportAll()         // every take still on this machine, newest first
await __inoutTakeLog()           // the verdict LINE of every take, including deleted ones
```

`__inoutTakeLog()` is the fleet: a ring of the last 60 takes in
`localStorage['inout.takeReport.v1']`, written as each take stops, so it outlives the
recordings themselves (`core/report/takeJournal.ts`). Everything else is recomputed from
IndexedDB, so a card is never stale.

`__inoutReport(recordingObject)` grades an object you paste in, without storing it — how a
historical take's black box (quoted in a task or a docblock) is re-graded years later.

## The verdict

| Verdict | Means |
|---|---|
| `green` | every dimension measured and inside its band |
| `red` | at least one dimension failed — `line` names it, with its numbers |
| `incomplete` | nothing failed, but something could not be measured |

`incomplete` is not a soft pass. An unread dimension is not a passed one (R1's ruling,
generalised): a take recorded before a witness existed, an Apple WebKit take whose audio
lane counts no silence, a card built without the wedge journal. The line says which.

## The ten dimensions

| id | Fails when | Read off |
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

Bands and their reasons are in `src/core/report/reportCard.ts`; each detail line quotes what
it measured, so a stricter gate (A1's `silentTailMs < 1 s`) is readable off a card that
passed.

### Two things the card deliberately does NOT claim

- **Memory is a point sample at stop, not a high-water mark.** Nothing samples during a
  take and nothing should — the hour-scale slope is task H3.
- **Revive bursts are runs, not attempts.** "25 attempts" says nothing; six separate deaths
  convicts the ladder. The regrouping uses `reviveSchedule.ts`'s own arithmetic (the gap to
  the next attempt equals the age of the silent run, capped at the ceiling). It cannot
  separate a new run that begins exactly one ceiling-length after the last attempt of a run
  already at the ceiling — the black box holds nothing that could, and merging understates
  the count rather than inventing one.

## What convicted the take this was built for

`rec_78ogcw052vdn` — 50.4 min, quality=max, camera + mic + tab audio — grades RED:

```
rec_78ogcw052vdn · 50.4 min · RED — audio-continuity: tab audio went to digital zeros
22.9 min in and never came back — 27.5 min of 50.4 min (54.5%) · rescue: tab audio 6
revive bursts (25 attempts), 5 after warm-up — runs began 0.2s, 189.4s, 455.1s,
707.7s, 1328.4s, 1376.3s.
```

…while `audio-clock` PASSES on the same take (5,647 ms of padding across 3,026 s is the
wall-clock hold working). That separation is the finding A1 starts from: the audio clock was
not starving, the input was. The take is pinned as a fixture in
`src/core/report/reportCard.test.ts` — if the card cannot convict it, it cannot convict
anything.
