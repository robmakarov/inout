# The screen wedge — full case file

**Status: OPEN as of 2026-08-25.** PO still hits it. Everything below is what has been
tried, what each attempt actually fixed, what each got wrong, and what remains. This doc
exists because the fix history is spread across eight commits and five ledger entries and
nobody — including the agents writing the fixes — should ever reconstruct it again.

## The bug

Press record → Chrome's picker → pick a surface → Chrome lights the sharing indicator →
**`getDisplayMedia` never resolves and never rejects.** The app shows "Waiting for
screen…", the take eventually arms without the screen, and the camera/mic stay held
meanwhile. Canonical console trace (PO, 2026-08-24, live build):

```
[capture:arming] display start      +0ms
[capture:arming] camera done    +1256ms — HD-камера FaceTime
[capture:arming] mic done       +1530ms — Микрофон MacBook Pro
[capture:arming] display timeout +120004ms — getDisplayMedia timed out
[capture:arming] armed +120007ms (2 channel(s), all start together)
```

The absence of `display done` **and** of any `system-audio done|failed` is the proof: the
system-audio mark fires in the same microtask getDisplayMedia resolves in, so the promise
never settled at all.

## Proven facts (each with its evidence)

| Fact | Evidence |
|---|---|
| The promise never settles — not slow, dead | trace above, twice, different days |
| The page never receives a track | same — so **no page code can release the claim** |
| Survives page refresh | PO, 2026-08-24 |
| Survives closing the tab and opening a new one | PO, 2026-08-24 — claim lives in Chrome's browser process |
| Cleared only by quitting Chrome (⌘Q) | PO, repeatedly |
| Survives a **fresh Chrome launch** (first take wedges) | PO, 2026-08-24 — so not accumulated state alone |
| Survives a **Chrome update** | PO, 2026-08-24 |
| Intermittent: "often, not always" | PO, 2026-08-24 |
| App's own arming cost is ~22 ms; the wait is never our code executing | measured in-browser, 2026-08-24 |
| **Accumulates within a Chrome session: "usually all okay first couple records, third or so start to have problem"** | PO, 2026-08-25 — the strongest new discriminator; consistent with Chrome leaking a capture-session claim per take until something saturates |
| After the wedged claim finally clears (a later refresh), the **mic indicator** can light instead, and the app can sit on "Waiting for microphone…" | PO, 2026-08-25 — the mic's timeout budget is chosen by `await permissions.query(...)`, an IPC into the same wedged browser process; if that never answers, no deadline is ever armed (acquire.ts `isGranted`). A bounded fail-fast was written, tested, and NOT shipped: PO ruled "it must not fail" — failing the mic faster is not a fix, the mic has to connect, and no page code can make a wedged browser deliver a stream. Do not re-ship a fail-fast here without PO asking |

## The attempts, in order, with honest outcomes

1. **Device-guard + release ordering** (`deviceGuard.ts`, cancel-releases-first,
   bounded teardown joins — 3f6d7f8). Fixed real leaks: delivered tracks can no longer
   outlive a cancel/stop/refresh, and "Cancelling…" can't hang. **Did not touch the
   wedge** — it releases tracks the page *has*; the wedge is a track the page never got.
2. **Same-tick mic dispatch** (`grants.ts` — 5816a7d). Fixed a real serialization bug
   (mic spin-up ran after the picker; measured 3026 ms → 52 ms post-picker wait).
   **Not the wedge** either — different bug that wore the same "waiting" label.
3. **8 s post-picker deadline via focus tracking** (`pickerClosed()` — b2b858c).
   **Failed in the field.** macOS Chrome delegates the picker to the system sharing pill;
   the page observes no focus change, the detector never armed, and the code fell back to
   120 s. The unit tests passed because they stubbed `hasFocus` — they proved the design
   against the stub, not against Chrome. Kept as a fast path only.
4. **30 s absolute ceiling** (`DISPLAY_TOTAL_BUDGET_MS` — 4b6f011). Works. Bounds the
   damage: a wedge now fails in ≤30 s instead of 120. **Does not prevent anything.**
5. **Wedged-primary kills the take and releases everything** (b2b858c). Works. No more
   screenless "screen recordings", no more camera/mic held while a dead promise waits out
   its budget. Denial (picker cancel) deliberately still arms a degraded take.
6. **Recovery advice in the error message.** Went through three versions because the
   first two were wrong: "close this tab" (disproved by PO), then "quit Chrome" (true but
   maximal), now "try again — safe mode kicks in; quit Chrome if twice in a row".
7. **Safe mode, first cut** (42725a9). **Regressed a working feature.** Dropped the
   `audio` request on the first wedge for 24 h — which removed Chrome's own "share tab
   audio" checkbox from the picker for a day, on a guess about which option is guilty.
   PO hit it within hours ("share sound toggle not there anymore").
8. **Safe mode as a ladder** (268223f — current state). Rung 1 drops size/fps
   constraints and surface hints (user-invisible); rung 2 — the floor — is bare
   `{video:true, audio:true}`. **No rung drops audio**; the checkbox is requested at
   every rung, always. Success at rung 0 clears the mark; everything expires 24 h after
   the last wedge.
9. **Picker pane meddling — shipped and reverted the same day** (9b13f67 → f35ba00).
   `monitorTypeSurfaces: 'exclude'` + a conditional pane hint removed the Entire-Screen
   option whenever Tab Audio was on, on the theory that macOS Chrome only offers a sound
   checkbox on the tab pane. PO's own whole-screen share HAS a system-audio checkbox, so
   the theory was wrong and it cost him a picker option. Reverted; the rule is now written
   in acquire.ts: **the picker is the user's, not ours** — never remove or reorder its
   surfaces without PO saying so.

## Ruled out

- **Stale build via the service worker** — sw.js is network-first for the document; a
  fresh navigation gets the current deploy. Verified by feature-marker in localStorage.
- **Stale Chrome session state alone** — a fresh Chrome launch wedged on its first take.
- **Outdated Chrome** — PO updated; still wedges.
- **The app holding devices across takes** — the guard provably zeroes held streams; and
  the wedge claim is in a process the page can't reach anyway.
- **Main-thread jank as the cause** — thread measured free at idle; one early "found it"
  on this was an instrumentation artifact (background-tab timer throttling) and is
  retracted.

## Still unknown — ranked

1. **One of our getDisplayMedia options × the macOS native picker.** The ladder is the
   experiment: if PO's takes succeed at rung 1 or 2, the guilty option is named by
   construction. If rung 2 (bare video+audio) still wedges, our options are innocent.
2. **macOS ScreenCaptureKit permission-state rot for Chrome.** The one lever never yet
   confirmed tried: System Settings → Privacy & Security → Screen & System Audio
   Recording → toggle Chrome off/on, restart Chrome. If the wedge survives *that* plus
   rung 2, it is fully outside anything we control.
3. **A Chrome native-pill bug independent of options.** Consistent with "often, not
   always" and with surviving everything. If true, the ladder rungs all wedge, quit-Chrome
   remains the only cure, and our job is exactly what is already shipped: bound it,
   release everything, say the truth, count it.
4. **(New, 2026-08-25) A per-take claim leak inside Chrome's capture stack.** PO: first
   couple of records in a session are fine, the trouble starts "third or so" — something
   is accumulating per successful take, in a process the page can't inspect. The page
   provably stops every track it receives (deviceGuard, zero live streams after stop), so
   if this is real it is Chrome failing to release its own SCK/native-picker session when
   the page stops the track. Discriminator: after two clean takes, check
   `chrome://webrtc-internals` and the macOS sharing pill BEFORE the third — a claim
   showing there with zero live tracks in the page confirms it, and it is Chrome's bug to
   file, with that page as the repro.

## What the next wedge must capture (evidence kit)

- The `[capture:arming]` timeline (already in the console — the one artifact that has
  driven every real finding so far).
- The active ladder rung (`inout.displayWedge.v1` in localStorage).
- `chrome://webrtc-internals` while wedged — shows whether the capture request exists at
  Chrome's layer.
- Chrome version, and whether the macOS sharing pill appeared before the hang.
- `display_wedge` analytics now fire with rung + count; once a sink is wired this stops
  depending on PO reporting it by hand.

## What users get today, wedge or no wedge

Failure is bounded (≤30 s, usually 8), every device is released at the failure, no take
silently records without its primary, the retry self-heals through the ladder without
removing anything visible for more than one take, the error text says the truth, and
every occurrence is counted.
