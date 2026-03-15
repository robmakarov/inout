# Text

Typography and copy rules. Code should use these fonts and, where applicable, the listed copy.

## Fonts

- **--mono** — DM Mono. Default body and UI.
- **--sans** — Syne. Headings, logo, emphasis (e.g. Send button).

## Sizes / weight (reference)

- Body: 13px, line-height 1.6
- Small labels / buttons: 9–11px, uppercase, letter-spacing
- Logo: 15px, weight 800, uppercase
- Message text: 13px
- Time: 6px (or hidden by view prefs)
- Sender: 10px (or hidden)

## Copy (labels, placeholders)

- Input placeholder: "say something…"
- Sign in: "Sign in"
- Account modal: "Account", "Status", "Not signed in", "Version", "Nickname", "Your user id", "Copy ID", "Save nickname", "Get Pro"
- Channel modal: "New feed", "Name", "e.g. team-a", "Your user id", "Automatically added to this feed.", "Share with user ids", "comma separated user ids", "Paste other INOUT user ids to share this feed.", "Cancel", "Create"
- Manage: "Select", "All", "None", "Delete", "Move", "Export", "View ▾", "Time", "Author"
- Empty state: "Nothing yet" (or similar)
- Scroll: "↓ new messages"
- Bubbles: "Paste", "Dismiss", "Copy", "Send", "Delete", "From clipboard", "Log"

## Rules

- Use var(--mono) and var(--sans); do not hardcode font names.
- Keep placeholder and button copy consistent with this list unless the spec file is updated.
