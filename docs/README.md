# INOUT documentation (for humans and AI)

This folder holds reference docs for the INOUT codebase. Use it to understand flows, find functions, respect styling, and avoid pitfalls. **When doing tasks, update the relevant doc** (e.g. add a function to `functions-index.md`, note a gotcha in `edge-cases.md`, or extend `ELEMENTS.md` in the repo root).

## What’s here

| File | Use when |
|------|----------|
| **README.md** (this file) | You need an index or a reminder to keep docs updated. |
| **architecture.md** | You need init order, auth flow, realtime lifecycle, or data flow (Supabase ↔ state ↔ DOM). |
| **functions-index.md** | You need to find a function by name or see what exists (one-line purpose per function). |
| **styling.md** | You change CSS: variables, body/class states, breakpoints, key classes. |
| **edge-cases.md** | You need conventions, gotchas, or “don’t do X” (e.g. script tags, feedback loops, localStorage). |

## Root-level docs (not in this folder)

- **README.md** — Project overview, run locally, tech stack, file layout, data model, project prompt for AI.
- **ELEMENTS.md** — DOM elements, JS state, conditions, and functions (detailed reference).

## Keeping docs updated

- After adding or changing a **function** that others might search for: add or update its entry in **functions-index.md**.
- After changing **init order**, **realtime**, or **auth flow**: update **architecture.md**.
- After changing **CSS variables**, **breakpoints**, or **body/class states**: update **styling.md**.
- When you hit or fix a **gotcha** (e.g. feedback loop, escaping, RLS): add it to **edge-cases.md**.
- When you add **new DOM elements or global state** or change who sets them: update **ELEMENTS.md** in the repo root.

AI: when completing a task, consider whether any of these docs need an update and edit them in the same change set.
