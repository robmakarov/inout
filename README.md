## INOUT – Desired User Experience

### Core idea

INOUT is an **objects app** (not a chat). Users keep and manage objects, collected into **Views**. Any number of Views can be open at once in the multiview area; each View is fully independent in layout, scroll, manage bar, and selection, but they all share the same base of objects and the same global input.

### Views and multiview

- **Views** are the primary unit of navigation and sharing. A View is identified by its `channel` name but is always presented as a generic “View” in the UI (no “primary/secondary”, no “tabs vs feeds” distinction).
- The header “Views bar” shows all Views available on this device/account; each View can be opened in multiview, closed, and later reopened without losing its state.
- **Multiview** can contain any number of open Views at the same time. Each open View:
  - Has its own manage bar (Select, Delete, Move, Export, View options, Close).
  - Remembers its own scroll, selection, edit state, and local preferences.
  - Can be rearranged in layout (future step), but swapping or duplicating Views never changes their identity.

### Objects and realtime doppelgangers

- A single **object** can appear in multiple Views at once. All those appearances are “doppelgangers” of the same underlying object.
- Editing an object in one View updates it **realtime** in all other Views and on all other devices that see that object.
- While editing, the caret and selection are mirrored across all doppelgangers; a remote‑editing badge shows who is editing and from which device, but the badge is visually subtle and sized to nickname.

### Modes

- Interaction **modes** (Select, Edit, Reorder, Realtime Inspect, etc.) are **separate** from Views and objects:
  - Views don’t “own” modes; modes act on whichever objects are in focus/selected.
  - The global manage bar above multiview can act on the union of selected objects across all open Views.
- There is **no “reorder mode button”**; reorder is always available, with its state saved per user and applied everywhere that object appears.

### Anonymous / device users

- A user without an account can still:
  - Create Views and objects.
  - Edit, reorder, and manage objects.
  - Persist their “local base” on the device, backed by `localStorage` + PWA shell, so the app opens and works offline.
  - On any device, open an in-app keyboard with language toggle, emoji/symbol helpers, cursor move keys, smart word suggestions, and a toggle to disable system keyboard invocation.
  - Open a custom calculator panel from the input tools for math/logic expressions and insert results directly into input.
- The profile menu for non‑account users exposes:
  - **Export local base** (JSON).
  - **Clear from this device** (remove local storage + service worker caches and reload).

### Signed‑in users and ownership

- A signed‑in user has cloud‑backed storage for Views and objects.
- Each View has an **owner** (first authenticated user who creates or claims it). Ownership:
  - Controls long‑term persistence and visibility in the owner’s nav bar.
  - Allows inviting others into that View.

### Visit links and guests (QR flow)

- From the account drawer, a signed‑in user can generate a **Visit QR** for a specific View:
  - The QR is a link that opens that **same owner‑owned View** for guests, not a copy.
  - The QR is shown in a full‑screen, animated modal with clear branding and a close button in the top‑right corner.
- When a guest (no account) opens the link:
  - The shared View is added to their Views bar and opened automatically.
  - They see all objects in that View, including the owner’s existing objects.
  - They get **full realtime access**: create, edit, reorder, and delete, with changes immediately visible to the owner.
- On the owner side:
  - The shared View appears in their Views bar as a normal View and persists there like any other until explicitly deleted.
  - Realtime keeps both sides fully in sync: same set of objects, same order, same edits.

### Access model

- Access to a View is **public‑by‑key**:
  - Anyone (account or not) with the visit link can see and edit that View in realtime.
  - Without the link/key, the View is not discoverable.
- In code, this is implemented as:
  - A normal, owner‑owned View (channel) with cloud objects.
  - Guests granted full rights to that View via a shared key / session, not by being separate “temporary owners”.

### Optimization

- **Realtime insert batching**: Realtime INSERT events are buffered per channel and flushed once per tick. Multiple rapid inserts (e.g. paste or bulk add) cause a single DOM update and reflow per channel instead of one per object.
- **Further ideas**:
  - **Virtualize the feed**: Render only visible rows (e.g. with a virtual list or Intersection Observer) so feeds with hundreds of objects stay fast.
  - **Collapse objects in UI**: Optionally group objects (e.g. by date or tag) and show a header with expand/collapse, so the list is shorter and fewer nodes are in the DOM.
  - **Event delegation**: Attach one listener on the feed container and use `event.target.closest('.obj')` instead of many per-row listeners to reduce memory and speed up add/remove.

