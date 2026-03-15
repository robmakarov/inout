# INOUT documentation (for humans and AI)

**In this project, documentation = all `.md` and `.txt` files in the repo** — root (README.md, TODO.txt), **documentation/** (this folder), and **design-system/** are all documentation. Keep them accurate and in sync with code and each other.

**Rebuild from scratch:** use **documentation/REBUILD.md** — single spec (product, stack, files, data, init, flows, DOM, state, styling, security, edge cases, design system). Everything else is a deep-dive or index.

## What's in this folder (documentation/)

| File | Use when |
|------|----------|
| **REBUILD.md** | Rebuilding the app or onboarding; single source for behavior and structure. |
| **README.md** (this file) | Doc index and reminder to keep docs updated. |
| **CODE-REFERENCE.md** | Every variable, constant, and function in app.js with a short description. |
| **architecture.md** | Init order, auth flow, realtime lifecycle, data flow (Supabase ↔ state ↔ DOM). |
| **ELEMENTS.md** | DOM elements, JS state, conditions, functions (detailed reference). |
| **functions-index.md** | Find a function by name; one-line purpose per function. |
| **styling.md** | CSS variables, body/class states, breakpoints, key classes. |
| **edge-cases.md** | Conventions, gotchas, "don't do X". |
| **security.md** | RLS, channel_members, creator_id; runnable SQL. |

## Other documentation (same project docs)

- **README.md** (root) — Overview, run, stack, file layout, project prompt for AI.
- **TODO.txt** (root) — Backlog, roadmap, tech debt.
- **design-system/** — UI/UX: components.md, modes.md, animations.md, colors.md, text.md, dnd.md. Also documentation; keep in sync per .cursor/rules/docs.mdc.

## Keeping docs updated

- **REBUILD.md** — Update when product, init, flows, DOM, or state change so rebuild stays accurate.
- **functions-index.md** — Add/update when adding or renaming functions.
- **architecture.md** — When changing init order, realtime, or auth flow.
- **styling.md** — When changing CSS vars, breakpoints, or state-driven classes.
- **edge-cases.md** — When fixing or discovering a gotcha.
- **ELEMENTS.md** — When adding/changing DOM or global state.

**Keeping all text files in sync:** Project text files = all `.md` and `.txt` in the repo. See **.cursor/rules/docs.mdc** for a table mapping code changes to which text file(s) to update. Rules: same change set as the code; REBUILD.md = single rebuild source; keep every .md and .txt accurate and consistent with code and each other. AI and humans should follow it.
