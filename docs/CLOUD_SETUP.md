# Cloud setup (Supabase)

Cloud sharing is optional — without it, INOUT still offers local file download.

1. Create a project at https://supabase.com (free tier is fine).
2. Enable Google sign-in:
   - In Google Cloud Console: create an OAuth 2.0 Client ID (type "Web application")
     and add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorized
     redirect URI.
   - In Supabase: Authentication -> Providers -> Google -> enable, paste the client
     ID and secret.
   - In Supabase: Authentication -> URL Configuration -> add your app origin
     (e.g. `http://localhost:5173`) to the redirect allow list.
3. Run `supabase/schema.sql` in the Supabase SQL editor (creates the `shares`
   table, the private `exports` bucket, and RLS policies).
4. Copy the project URL and anon key (Settings -> API) into `.env` at the repo root:

   ```
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon-key>
   ```

   Restart the dev server; the "Cloud link" share target appears when both are set.

Limits: sized for the Supabase free tier. Each user gets a 512 MB quota
(client-checked for UX; RLS enforces ownership) and share links expire after
7 days. Expired shares are cleaned up lazily by the client, or server-side via
the optional pg_cron job in `schema.sql`. "Delete all data" removes every file
and row a user owns; deleting the auth user record itself requires the service
role key (server-side) and is out of MVP scope.

E2EE direction: the server only ever stores opaque media bytes plus minimal
metadata (file name, size, timestamps), so client-side encryption can be added
later without changing the data model or the CloudProvider interface.
