INOUT
=====

Minimal, single-file, realtime message app built on:

- Static `index.html` (no build, no framework)
- Supabase (Postgres + Realtime + Auth + RLS)
- Vercel static hosting

Current behavior
----------------

- Google-authenticated users can sign in and out.
- Each user has:
  - A private `Main` feed.
  - Custom feeds (tabs) they create.
- Feeds are **per channel name** and can be:
  - Private (only the creator is a member).
  - Shared: creator can add other users by Supabase user id.
- Messages:
  - Are stored in `public.entries` with `user_id` and `channel`.
  - Are only readable if:
    - You are the sender (`user_id = auth.uid()`), or
    - You are a member of that channel via `channel_members`.
- UI:
  - Sticky header with INOUT logo, online count, message count, auth status, **Copy ID** button.
  - Thin red separator bar and horizontal tab strip (`Main`, plus user-defined feeds).
  - Center feed with time, text, and message number.
  - Textarea at bottom; `Enter` sends, `Shift+Enter` inserts newline.

Key Supabase pieces
-------------------

- Project: `tfmbqiwxfgrwtjvoqomf`
- URL: `https://tfmbqiwxfgrwtjvoqomf.supabase.co`
- Anon key: `sb_publishable_QzPgZBu5XwFXmnvD-DYCRw_EWFuhLn_`

Tables:

- `public.entries`
  - `id bigint primary key identity`
  - `created_at timestamptz default now()`
  - `updated_at timestamptz default now()`
  - `text text`
  - `user_id uuid references auth.users(id)`
  - `channel text not null default 'main'`
- `public.channel_members`
  - `channel text`
  - `user_id uuid references auth.users(id)`
  - `inserted_at timestamptz default now()`
  - primary key `(channel, user_id)`

High-level RLS (conceptual)
---------------------------

- `channel_members`:
  - Authenticated users can manage memberships for channels they belong to.
- `entries`:
  - Authenticated users can `SELECT` rows where:
    - `user_id = auth.uid()` **or**
    - There exists `channel_members` with same `channel` and `user_id = auth.uid()`.
  - Inserts are allowed only for authenticated users with `user_id = auth.uid()` (enforced in policy and in client).

Project prompt
--------------

Use this prompt when asking an AI to work on this repo:

> You are editing **INOUT**, a single-file web app (`index.html`) hosted on Vercel.  
> Rules:  
> - Only touch `index.html` (and `vercel.json` if routing changes are needed).  
> - No build tools, no bundlers, no external JS besides `@supabase/supabase-js`.  
> - Optimize for **performance and simplicity over abstractions**.  
> - Keep the visual style: dark, minimal, DM Mono + Syne, thin red separator, compact typography.  
> - Authentication is via Supabase Google OAuth; respect existing RLS (per-user feeds and shared channels via `channel_members`).  
> - Feeds are tabbed channels stored in `entries.channel`; users can create and delete tabs (except `Main`), and share them with other users by Supabase user id.  
> - Preserve the current UX: realtime feed, presence count, sticky header, textarea input with Enter/Shift+Enter behavior, small toast notifications, and responsive layout.  
> - When adding features, avoid introducing new global state libraries; use plain JavaScript and DOM APIs inside `index.html`.  

Local dev
---------

From the repo root:

```bash
npx serve -l 4173 .
```

Then open `http://localhost:4173` in the browser.

