-- INOUT: allow empty `entries.text` (clear object body) and remove common DB blocks.
-- Apply order: see ../README.md (run 211800, then 212000, then 212100).
-- Supabase Dashboard → SQL → New query → Run, or: supabase db push
--
-- If edits still fail, inspect the RPC (section 3) and remove any trim/length guard.

-- ── 1) Diagnose: table constraints on public.entries (run alone if you want to see names)
-- SELECT c.conname, pg_get_constraintdef(c.oid) AS def
-- FROM pg_constraint c
-- WHERE c.conrelid = 'public.entries'::regclass
-- ORDER BY c.contype, c.conname;

-- ── 2) Drop CHECK constraints that block empty body text (harmless if missing).
--    After running section 1, add your real constraint name here if needed:
--    ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS your_constraint_name;

-- Optional: auto-drop CHECKs on `entries` whose definition mentions `text` + length/trim.
-- Uncomment only if section 1 shows a matching row you want removed.
/*
DO $migration$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    WHERE c.conrelid = 'public.entries'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ~* 'text'
      AND pg_get_constraintdef(c.oid) ~* 'char_length|length\\s*\\(|trim|btrim|<>\\s*'''''
  LOOP
    EXECUTE format('ALTER TABLE public.entries DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Dropped: % — %', r.conname, r.def;
  END LOOP;
END $migration$;
*/

-- Common hand-picked names:
ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS entries_text_nonempty;
ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS entries_text_not_empty;
ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS chk_entries_text;
ALTER TABLE public.entries DROP CONSTRAINT IF EXISTS entries_text_check;

-- Ensure column allows empty string (NULL is separate; app sends '').
-- If your column is nullable and you rely on '', you can still keep nullable.
ALTER TABLE public.entries
  ALTER COLUMN text SET DEFAULT '';

-- ── 3) Diagnose: perform_entry_action body (run in SQL editor; edit in Dashboard if it rejects '')
-- SELECT pg_get_functiondef(p.oid)
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE n.nspname = 'public' AND p.proname = 'perform_entry_action';

-- If the function contains something like:
--   IF length(trim(...)) = 0 THEN RAISE ...
-- remove that branch so '' is accepted for action 'edit'.
