# Cloud reset runbook — replace the old INOUT deployment, keep auth users
Purpose: the same URL (inout-kappa.vercel.app) serves the new app, all old data/secrets/deployments are gone, the 2–3 existing login accounts are kept. Robert executes every dashboard step (keys never pass through agents). Order matters.

1. Publish new code (Robert, terminal, once): force-replace GitHub main with the depersonalized single-commit history (already prepared on branch `publish`); delete stale branches. After the push Vercel auto-builds the new app.
2. Vercel (vercel.com → project):
   - Settings → Git: confirm it builds `robmakarov/inout` @ main; framework Vite, build `npm run build`, output `dist`.
   - Settings → Environment Variables: DELETE every old variable (old Supabase URL/keys etc.). Add nothing yet — the app runs fully local-first without them.
   - Deployments: confirm the new build is Production on inout-kappa.vercel.app, then DELETE all older deployments (each stays reachable at its own *.vercel.app URL until deleted).
3. Supabase (supabase.com → old project). KEEP Authentication → Users (the 2–3 accounts). Everything else goes:
   - Storage: delete all objects in every bucket (or delete the buckets).
   - SQL editor: `select tablename from pg_tables where schemaname='public';` then `truncate table <each> cascade;` (or drop them — the new schema ships with cloud setup later).
   - Settings → API: regenerate anon + service_role keys (old keys may live in old deploys/logs).
   - Settings → Auth → JWT: rotate the JWT secret — all existing sessions die; users stay and log in again.
   - Authentication → Providers → Google: rotate the OAuth client secret in the Google Cloud console, paste the new one here. Users keep working (identity is the Google account, not the secret).
4. GitHub hygiene (after the push): old commits become unreachable but may persist in caches/forks — check github.com/robmakarov/inout/forks; if any exist or absolute removal matters, GitHub Support can purge unreachable objects.
5. Re-enable cloud sharing later, when provisioning: follow docs/CLOUD_SETUP.md with the NEW keys; set `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the Vercel env, redeploy. Until then the deployed app works offline-only by design.

Done when: same URL serves the new app · zero old tables/objects/deployments/env vars · all keys + JWT + OAuth secret rotated · auth users intact.
