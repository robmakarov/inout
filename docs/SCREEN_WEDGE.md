# The screen wedge — full case file

**Status as of 2026-08-30: NOT prevented, contained to one press, and instrumented to
convict.** Robert stalled four times in one run — across the app's own ritual reloads and
two Chrome relaunches — which killed the two comfortable stories at once: a fresh document
does not cure it and a fresh Chrome does not reliably cure it either. Everything that was
OURS in the failure is fixed (the list below); what remains is a promise no page code can
cancel, in a layer no page code can reach, and the forensics that will name that layer the
next time it fires.

## WHEN ROBERT REPORTS IT AGAIN — the playbook. Start here, do not re-derive.

1. **Get two console lines** (screenshot is enough):
   `[capture] asking Chrome for …` — carries the RUNG (`reduced request N/3`), and
   `[capture:forensics] …` — carries the verdict fields. If he has no console, the same
   fields rode the `display_wedge` analytics event.
2. **Read the verdict:**
   | What the lines say | Verdict | What to do |
   |---|---|---|
   | Wedges stopped once the ladder reached rung 3 | our request contents were the trigger | nothing — the ladder holds; note which rung cured it here |
   | rung 3 + `focus never left` + `0 screen deliveries this session` | **below Chrome** — macOS SCK/replayd, incl. its periodic re-auth dialog that can open BEHIND every window | no web API can prevent it (getDisplayMedia has no abort, no silent pre-flight). Put the two endpoint levers to Robert — see the last section — and change nothing else |
   | rung 3 + `focus left and came back` | Chrome's picker/capture service | file upstream (repro recipe below, attach `chrome://webrtc-internals` + the forensics line); containment already does the rest |
3. **Do NOT rebuild or re-propose what is already ruled**, it is all shipped or ruled out:
   containment = a wedge costs one press (instant stale-refusal + one auto-reload,
   `displayInflight.ts`); the ladder never climbs on good takes (day-probe only,
   `displayWedge.ts`); no instructions are ever shown to the user and no System Settings
   deep-link (Robert, twice, DECISIONS 2026-08-30 (1) and (2)); no console remedies; no
   held share between takes (same rulings).
4. **His machine's state**, if needed: `inout.displayWedge.v1` (localStorage — rung, count,
   stall run), `inout.screenDeliveries.v1` (sessionStorage — the clustering number).

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
| **A page reload does not cure it: four stalls in one run ACROSS the ritual's own reloads** | Robert, 2026-08-30 — fresh document, same stall; the poison is not frame-scoped |
| **A Chrome relaunch did not cure it that day (⌘Q twice mid-run, stalls continued)** | Robert, 2026-08-30 — the strongest pointer BELOW Chrome: macOS SCK/replayd/re-auth state survives the browser |
| **Every 2026-08-30 stall happened with the ladder already on rung 2** | his stored state, read off the Chrome profile: `level:2, count:5` — so the old floor's remaining contents (our three raw-audio flags) went on trial: rung 3 is bare `{video, audio}` |
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
12. **One outstanding screen request per document** (`displayInflight.ts`, 2026-08-30).
   A wedged promise leaves its REQUEST booked against the RenderFrame with no way to
   cancel it (the spec has no abort), so every later press used to dispatch a second
   request into a poisoned frame — that is the shape of "four stalls in a row". Now a
   request our own budget declared dead refuses the next dispatch instantly ('stale'
   reason), the app always reloads on it, and the cost of a wedge is one press. Narrowed
   so a cancelled picker is not poison.
13. **The climb is gone** (2026-08-30). Twice a good-take counter walked the machine back
   onto the rung that wedges it (W1: one take → wedge every 2nd record; then three →
   every 4th). A good take at rung N is evidence about rung N only. The only way up is a
   full day with no wedge, one rung per day (`WEDGE_PROBE_AFTER_MS`); rungs drop nothing
   the user chose and nothing announces a mode, so sitting degraded costs ~nothing.
14. **Rung 3 — the floor that actually is one** (2026-08-30). Rung 2 still sent our three
   raw-audio flags on an unmeasured claim they "cannot hang a request"; his five wedges
   all happened ON rung 2. Rung 3 sends bare `{video, audio}` and the raw flags move to
   the delivered track (`repairDisplayAudio`) — checkbox stays in the picker, music stays
   raw. Machines parked on the old floor with count > 2 migrate to it on load.
15. **Stall forensics** (`stallForensics.ts`, 2026-08-30). A page can see exactly two
   things that leak out of the capture service: focus and time. Every display request is
   watched from dispatch; a stall prints one console line (focus story + deliveries this
   session + page age) and ships the same fields on `display_wedge`. This is what turns
   the NEXT wedge into a verdict — see the playbook at the top.

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
   experiment: if the wedges stop at a rung, the guilty option is named by construction.
   2026-08-30 sharpened it: rung 2 was never actually bare (it still carried our three
   raw-audio flags, and all five of his that day happened ON rung 2) — rung 3 is the
   truly bare `{video, audio}` request. A stall there clears our options entirely.
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

AUTOMATED as of 2026-08-30: the `[capture:forensics]` console line + the `display_wedge`
analytics event carry the rung, the focus story, deliveries-this-session, page age and
wait time — the playbook at the top reads the verdict straight off them. Still worth
grabbing by hand if reachable: `chrome://webrtc-internals` while wedged (does the request
exist at Chrome's layer), and whether the macOS sharing pill appeared before the hang.

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

**Rewritten 2026-08-30 — the user is told less, on purpose.** The W1 banner texts (the
System Settings path, the ⌘Q escalation) and the Reset button are GONE, on Robert's two
rulings that day: "no fucking opening system settings, search for no user action ways" and
"i will not do anything in console". A remedy the user must perform is not a fix. What the
user sees now: the 12 s still-running notice (claims nothing failed), and on failure a
sticky banner that says what happened, that nothing was recorded, and that the app has
narrowed its request — the next press is the whole of their job. Every escalation is
automatic: rung down, stale-refusal, one reload.

## The two endpoint levers — both Robert's call, neither buildable without him

If the playbook's verdict lands on "below Chrome" (or on "Chrome's picker path" and
upstream never fixes it), the page is out of moves and these are the only two left:

1. **Hold the share across takes** (was O12). One picker per session instead of one per
   take — removes the failure surface instead of containing it, and his own field evidence
   supports it (share-first-then-load-the-game never wedged). RULED OUT TWICE, 2026-08-30
   (DECISIONS (1) and (2)): the sharing indicator would be lit while nothing records, and
   "devices are touched ONLY after the record click" stands. Do not re-propose it;
   re-open only if HE brings it up.
2. **A native capture layer** (wrapper owning ScreenCaptureKit directly): can pre-flight
   the grant (`CGPreflightScreenCaptureAccess`), retry, and kill its own hung stream —
   the primitives the web platform is missing. Off the MVP roadmap; it is the "make it
   never happen" endpoint if the verdict proves the OS layer.
