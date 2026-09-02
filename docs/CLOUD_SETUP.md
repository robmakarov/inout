# Cloud setup (Supabase) — optional cloud sharing
Purpose: provision Supabase + Google sign-in so the "Cloud link" share target appears. Cloud sharing is optional — without it INOUT still offers local file download.

1. Create a project at https://supabase.com (free tier is fine).
2. Google sign-in:
   - Google Cloud Console: create an OAuth 2.0 Client ID, type "Web application"; add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI.
   - Supabase: Authentication → Providers → Google → enable, paste the client ID and secret.
   - Supabase: Authentication → URL Configuration → add the app origin (e.g. `http://localhost:5173`) to the redirect allow list.
3. Run `supabase/schema.sql` in the Supabase SQL editor (creates the `shares` table, the private `exports` bucket, the RLS policies, and the optional pg_cron cleanup job).
4. Copy the project URL and anon key (Settings → API) into `.env` at the repo root:
   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon-key>
   ```
   Restart the dev server; "Cloud link" appears when both are set.

Limits (sized for the Supabase free tier):
- 512 MB quota per user — client-checked for UX; RLS enforces ownership.
- Share links expire after 7 days; expired shares are cleaned up lazily by the client, or server-side via the optional pg_cron job in `schema.sql`.
- "Delete all data" removes every file and row a user owns. Deleting the auth user record itself needs the service role key (server-side) — out of MVP scope.
- E2EE direction: the server stores only opaque media bytes + minimal metadata (file name, size, timestamps), so client-side encryption can be added later without changing the data model or the `CloudProvider` interface.
