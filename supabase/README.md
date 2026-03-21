# Supabase SQL for this project

Apply these **once** to your Supabase project (Dashboard → **SQL** → New query → paste → **Run**), **in this order**:

1. **`migrations/20260321180000_allow_empty_entries_text.sql`** — Allows empty object text and drops common CHECK constraints that block it.
2. **`migrations/20260321200000_perform_entry_action_match_rpc.sql`** — RPC `perform_entry_action` with 5 parameters (includes `p_temp_session_id`), drops the old 4-argument overload (fixes PostgREST `PGRST203`).
3. **`migrations/20260321210000_perform_entry_action_rowcount_audit.sql`** — RPC fails if no row was updated/deleted/moved; audit insert to `entry_actions` no longer rolls back the edit if that insert fails.

If you use the Supabase CLI: from the repo root, `supabase db push` (or link the project and push) applies migrations in filename order.

After pushing, hard-refresh the app. If edits still fail, open the browser **Network** tab, retry save, and check the failing request (REST `entries` or RPC `perform_entry_action`) for the error body.
