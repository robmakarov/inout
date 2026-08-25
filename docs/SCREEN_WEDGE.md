# The screen wedge — full case file

**Status as of 2026-08-25 (end of day): MITIGATED, root cause still Chrome's.** After the
full mitigation stack shipped (request serializer, persistent device connect, refresh
ritual, safe-mode ladder), PO's own stress test — the repro recipe below — came back
"seems to be allright now". The Chrome-side bug is NOT fixed and cannot be fixed from a
web page; if the wedge reappears, start from the formulation below and the evidence kit
at the bottom. This doc exists because the fix history is spread across a dozen commits
and nobody — including the agents writing the fixes — should ever reconstruct it again.

## The formulation — canonical, quote this when it happens again

> On macOS, Chrome's screen picker takes the share (the sharing indicator lights) but
> `getDisplayMedia` **never resolves and never rejects** — the page never receives a
> track, so no page code can release or retry the claim. The stuck state lives in
> Chrome's browser process: it survives page refresh, closing the tab, opening a new
> tab, and sometimes a fresh Chrome launch; only quitting Chrome completely (⌘Q)
> reliably clears it. It is intermittent, and it accumulates with the number of shares
> taken in one Chrome session — rapid record/stop cycles (≈10 × 2-second takes)
> reproduce it at will. The app bounds the damage (fail ≤30 s, all devices released, no
> screenless take, one automatic refresh, reduced request on retry) but cannot cure the
> browser process.

If reporting it to Chromium: it is a `getDisplayMedia` promise that never settles after
the native macOS (SCContentSharingPicker) picker confirms, reproducible by cycling
share/record/stop rapidly; attach `chrome://webrtc-internals` from the wedged state.

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
| **Reproducible at will by rapid cycling: "connect screen, 2 seconds recording, back and again 10 times — it happens again"** | PO, 2026-08-25, after the persistent-connect ship. Confirms per-take accumulation and gives the case file its first repro recipe |
| After the wedged claim finally clears (a later refresh), the **mic indicator** can light instead, and the app can sit on "Waiting for microphone…" | PO, 2026-08-25 — the mic's timeout budget was chosen by `await permissions.query(...)`, an IPC into the same wedged browser process; when it never answered, no deadline was ever armed. A bounded fail-fast was written and REFUSED by PO ("it must not fail" — the mic has to connect, not fail faster). PO then ordered the opposite contract: "all input must connect everytime without fails" → **persistent connect shipped** (acquire.ts `connectPersistently`): the lookup is bounded (cached grant as fallback), a granted mic/camera is re-asked — 2 attempts before the take starts, then an endless paced background hunt that late-joins the device the moment the browser delivers. Fenced: granted devices only, dies with the take / the user's off-switch / a denial. The SCREEN cannot be hunted — getDisplayMedia needs a fresh user gesture per ask |

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
10. **Share requests serialized against the previous share's release**
   (`displayRelease.ts`, 2026-08-25, prompted by the rapid-cycling repro). Our own stop
   path keeps the display track alive while it starves and drains the recorder
   (P0-tail-raw), so a fast re-record raced that teardown — the one overlap the page
   controls. Every delivered display track is registered; the next getDisplayMedia waits
   (sync no-op when clear, ≤3 s budget, 800 ms grace after the last track ends) before
   dispatching. Apple WebKit exempt (same-tick dispatch is law there; it does not wedge).
11. **The refresh ritual** (`wedgeReload.ts`, 2026-08-25 — PO: "if it happens make it
   fixed by refresh of app page"). A wedge already fails the take with every device
   released, so the app reloads ITSELF once — fresh renderer, fresh mojo pipes to the
   capture service — and boots with "press record to try again". A wedge inside 2 min of
   that reload gets no second one; the error text then says the remaining truth (⌘Q).
   Honest limit: the claim provably lives in the browser process (survives tab close), so
   a refresh is not guaranteed to clear it — the ritual automates the cheapest cure and
   the escalation stays one step behind.

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

A new share request never races the previous share's teardown (serialized, invisible at
normal pace). Failure is bounded (≤30 s, usually 8), every device is released at the
failure, no take silently records without its primary, the app refreshes itself once and
invites a retry, the retry self-heals through the request ladder, a second wedge right
after the refresh gets the honest ⌘Q text, and every occurrence is counted.

## The one unbuilt lever — parked on the roadmap

**Keep the screen share alive between takes** (.ai/TASKS O12, PO-gated, deferred
2026-08-25 "we will consider it later"): one share for the whole session removes the
picker from every take after the first and the create/teardown churn the wedge
accumulates on. Cost: the sharing indicator stays lit between takes. PO's call.
