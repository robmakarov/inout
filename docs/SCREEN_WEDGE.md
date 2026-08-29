# The screen wedge — full case file

**Status as of 2026-08-29 (W1): NOT mitigated — Robert hit it three times in one
evening and reached rung 2 of the safe-mode ladder.** The 08-25 "MITIGATED" reading was
true when written (his stress test came back "seems to be allright now") and is retracted.
The Chrome-side bug is NOT fixed and cannot be fixed from a web page. What W1 changed is
the part that was OURS, because the mitigation stack had become its own failure mode:

- **The ladder had no way up.** A success cleared the mark from rung 0 only, so a machine
  degraded by a cause that was already gone stayed degraded for the full 24 h TTL. The
  only exit anyone found was a localStorage line typed into a console; handed that line,
  Robert answered "what the fuck is this?". Now any success climbs one rung, rung 0 clears
  outright, and two good takes walk a floored machine home. The TTL is the backstop it was
  always meant to be rather than the only door.
- **A timeout was counted as a wedge whatever caused it.** With macOS screen recording
  ungranted, Chrome's picker opens, says exactly that on screen, and `getDisplayMedia`
  never settles — identical from the page. So the ladder escalated against a permission no
  request of ours can satisfy, and the app reported "the device never connected", blaming
  the user's hardware for an OS toggle. Now `classifyDisplayStall` reads the one recorded
  fact that separates them (has this profile EVER been handed a screen track? the macOS
  grant is per-app and permanent), a permission stall does not touch the ladder, and the
  message names the permission and the browser the user is actually in.
- **The app said nothing until it gave up.** Every word about a stuck share arrived in the
  post-take banner, up to 30 s after the press, while Chrome had the real answer on screen
  the whole time. A notice now fires at 12 s, while the request is still running.
- **Backing off was asking for MORE** (fixed 2026-08-29, before W1): rung 1 dropped the
  SIZE and RATE bounds along with the exotic options, so a machine that had already choked
  once went on to capture its whole monitor uncapped. Rung 1 keeps the bounds; rung 2 is
  bare on purpose and is covered on the track by `capDisplayTrack`.

This doc exists because the fix history is spread across a dozen commits and nobody —
including the agents writing the fixes — should ever reconstruct it again.

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
meanwhile. Canonical console trace (Robert, 2026-08-24, live build):

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
| Survives page refresh | Robert, 2026-08-24 |
| Survives closing the tab and opening a new one | Robert, 2026-08-24 — claim lives in Chrome's browser process |
| Cleared only by quitting Chrome (⌘Q) | Robert, repeatedly |
| Survives a **fresh Chrome launch** (first take wedges) | Robert, 2026-08-24 — so not accumulated state alone |
| Survives a **Chrome update** | Robert, 2026-08-24 |
| Intermittent: "often, not always" | Robert, 2026-08-24 |
| App's own arming cost is ~22 ms; the wait is never our code executing | measured in-browser, 2026-08-24 |
| **Accumulates within a Chrome session: "usually all okay first couple records, third or so start to have problem"** | Robert, 2026-08-25 — the strongest new discriminator; consistent with Chrome leaking a capture-session claim per take until something saturates |
| **Reproducible at will by rapid cycling: "connect screen, 2 seconds recording, back and again 10 times — it happens again"** | Robert, 2026-08-25, after the persistent-connect ship. Confirms per-take accumulation and gives the case file its first repro recipe |
| After the wedged claim finally clears (a later refresh), the **mic indicator** can light instead, and the app can sit on "Waiting for microphone…" | Robert, 2026-08-25 — the mic's timeout budget was chosen by `await permissions.query(...)`, an IPC into the same wedged browser process; when it never answered, no deadline was ever armed. A bounded fail-fast was written and REFUSED by Robert ("it must not fail" — the mic has to connect, not fail faster). Robert then ordered the opposite contract: "all input must connect everytime without fails" → **persistent connect shipped** (acquire.ts `connectPersistently`): the lookup is bounded (cached grant as fallback), a granted mic/camera is re-asked — 2 attempts before the take starts, then an endless paced background hunt that late-joins the device the moment the browser delivers. Fenced: granted devices only, dies with the take / the user's off-switch / a denial. The SCREEN cannot be hunted — getDisplayMedia needs a fresh user gesture per ask |
| **Load at picker time is a trigger by ITSELF: a 4K game already running in another tab → the record attempt wedges; restart Chrome, take the share BEFORE starting the game → no wedge** | Robert, 2026-08-25 — ordering discriminator; per-take accumulation is not the only path in. The no-wedge ordering (share first, load after) is exactly the state O12 would make permanent |
| **In the game-load wedge the refresh ritual DID NOT deliver: the app went unresponsive, no automatic reload Robert could see, and no message told him to quit/reload Chrome** | Robert, 2026-08-25 — contradicts the "what users get today" list below for this ordering. Candidate causes, unproven: the renderer itself is janked by the same GPU load so the reload never runs or paints; or the failure path taken under load never classifies as `wedged` so wedgeReload is never asked. Needs the arming timeline from a repro |

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
   first two were wrong: "close this tab" (disproved by Robert), then "quit Chrome" (true but
   maximal), now "try again — safe mode kicks in; quit Chrome if twice in a row".
7. **Safe mode, first cut** (42725a9). **Regressed a working feature.** Dropped the
   `audio` request on the first wedge for 24 h — which removed Chrome's own "share tab
   audio" checkbox from the picker for a day, on a guess about which option is guilty.
   Robert hit it within hours ("share sound toggle not there anymore").
8. **Safe mode as a ladder** (268223f — current state). Rung 1 drops size/fps
   constraints and surface hints (user-invisible); rung 2 — the floor — is bare
   `{video:true, audio:true}`. **No rung drops audio**; the checkbox is requested at
   every rung, always. Success at rung 0 clears the mark; everything expires 24 h after
   the last wedge.
9. **Picker pane meddling — shipped and reverted the same day** (9b13f67 → f35ba00).
   `monitorTypeSurfaces: 'exclude'` + a conditional pane hint removed the Entire-Screen
   option whenever Tab Audio was on, on the theory that macOS Chrome only offers a sound
   checkbox on the tab pane. Robert's own whole-screen share HAS a system-audio checkbox, so
   the theory was wrong and it cost him a picker option. Reverted; the rule is now written
   in acquire.ts: **the picker is the user's, not ours** — never remove or reorder its
   surfaces without Robert saying so.
10. **Share requests serialized against the previous share's release**
   (`displayRelease.ts`, 2026-08-25, prompted by the rapid-cycling repro). Our own stop
   path keeps the display track alive while it starves and drains the recorder
   (P0-tail-raw), so a fast re-record raced that teardown — the one overlap the page
   controls. Every delivered display track is registered; the next getDisplayMedia waits
   (sync no-op when clear, ≤3 s budget, 800 ms grace after the last track ends) before
   dispatching. Apple WebKit exempt (same-tick dispatch is law there; it does not wedge).
11. **The refresh ritual** (`wedgeReload.ts`, 2026-08-25 — Robert: "if it happens make it
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
- **Outdated Chrome** — Robert updated; still wedges.
- **The app holding devices across takes** — the guard provably zeroes held streams; and
  the wedge claim is in a process the page can't reach anyway.
- **Main-thread jank as the cause** — thread measured free at idle; one early "found it"
  on this was an instrumentation artifact (background-tab timer throttling) and is
  retracted.

## Still unknown — ranked

1. **One of our getDisplayMedia options × the macOS native picker.** The ladder is the
   experiment: if Robert's takes succeed at rung 1 or 2, the guilty option is named by
   construction. If rung 2 (bare video+audio) still wedges, our options are innocent.
2. **macOS ScreenCaptureKit permission-state rot for Chrome.** The one lever never yet
   confirmed tried: System Settings → Privacy & Security → Screen & System Audio
   Recording → toggle Chrome off/on, restart Chrome. If the wedge survives *that* plus
   rung 2, it is fully outside anything we control. PARTLY ANSWERED 2026-08-29 (W1): on
   Robert's evening the grant WAS the cause at least once — it needs a Chrome relaunch,
   and until then every attempt hangs exactly like the wedge. That case is now named
   rather than escalated against; what remains unknown is whether a *granted* Chrome can
   also rot into this state.
3. **A Chrome native-pill bug independent of options.** Consistent with "often, not
   always" and with surviving everything. If true, the ladder rungs all wedge, quit-Chrome
   remains the only cure, and our job is exactly what is already shipped: bound it,
   release everything, say the truth, count it.
4. **(New, 2026-08-25) A per-take claim leak inside Chrome's capture stack.** Robert: first
   couple of records in a session are fine, the trouble starts "third or so" — something
   is accumulating per successful take, in a process the page can't inspect. The page
   provably stops every track it receives (deviceGuard, zero live streams after stop), so
   if this is real it is Chrome failing to release its own SCK/native-picker session when
   the page stops the track. Discriminator: after two clean takes, check
   `chrome://webrtc-internals` and the macOS sharing pill BEFORE the third — a claim
   showing there with zero live tracks in the page confirms it, and it is Chrome's bug to
   file, with that page as the repro.
5. **(New, 2026-08-25) The share handshake is load-sensitive.** A 4K game running before
   the picker opens wedged the record attempt; restart Chrome, share first, start the game
   after → no wedge (Robert). So saturating the browser/GPU process at share time can wedge
   with zero accumulated takes. Discriminator: replace the game with a synthetic GPU load
   (a WebGL stress tab) and repeat both orderings — if it reproduces, it is pure load, the
   game is irrelevant, and a clean Chromium repro exists.

## What the next wedge must capture (evidence kit)

- The `[capture:arming]` timeline (already in the console — the one artifact that has
  driven every real finding so far).
- The active ladder rung (`inout.displayWedge.v1` in localStorage).
- `chrome://webrtc-internals` while wedged — shows whether the capture request exists at
  Chrome's layer.
- Chrome version, and whether the macOS sharing pill appeared before the hang.
- `display_wedge` analytics now fire with rung + count; once a sink is wired this stops
  depending on Robert reporting it by hand.

## What users get today, wedge or no wedge

A new share request never races the previous share's teardown (serialized, invisible at
normal pace). Failure is bounded (≤30 s, usually 8), every device is released at the
failure, no take silently records without its primary, the app refreshes itself once and
invites a retry, the retry self-heals through the request ladder, a second wedge right
after the refresh gets the honest ⌘Q text, and every occurrence is counted.
FIELD-CONTRADICTED for the game-load ordering (Robert, 2026-08-25): in that wedge the app went
unresponsive with no visible reload and no ⌘Q message. HALF OF THAT WAS OURS AND IS FIXED
the same day — the boot notice was due only within 15 s of the reload stamp, and a wedge
happens when the machine is saturated, which is exactly when the reload takes longest to
boot; the notice is now an owed flag consumed once (bounded at 2 min), a STICKY banner
rather than a 4 s toast (the user is in the tab they were recording), and it carries the
⌘Q escalation itself instead of waiting for a second wedge to say it. What is still
unproven is whether the reload ran at all under that load — that needs the arming timeline
from a repro. BACKLOG P1.

**Added by W1, 2026-08-29.** At 12 s — while the request is still alive and 18 s before it
fails — the app now says which of the two failures this looks like, in a sticky banner:
an ungranted macOS screen-recording permission (with the System Settings path, naming the
browser the user is actually in) or Chrome's stuck share. A permission stall never
escalates the safe-mode ladder and never spends the one automatic refresh, because a fresh
renderer cannot change a TCC grant — it only hides the message that names the fix. A
degraded machine says so on the capture screen and carries a **Reset screen sharing**
button; before W1 the only exits were a 24 h timer and a console.

## The one unbuilt lever — parked on the roadmap

**Keep the screen share alive between takes** (.ai/TASKS O12, Robert-gated, deferred
2026-08-25 "we will consider it later"): one share for the whole session removes the
picker from every take after the first and the create/teardown churn the wedge
accumulates on. Cost: the sharing indicator stays lit between takes. Robert's call.
Robert's 2026-08-25 game-first case is direct field evidence for it: the ordering that avoids
the wedge (share taken first, load started after) is exactly the state O12 makes permanent.
