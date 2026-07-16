-- INOUT cloud schema. Run once in the Supabase SQL editor.
-- RLS is the real enforcement; client-side quota checks are UX only.

-- Shares metadata -------------------------------------------------------------

create table if not exists public.shares (
  id text primary key,
  user_id uuid not null default auth.uid(),
  file_name text not null,
  object_path text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.shares enable row level security;

create policy "shares_select_own" on public.shares
  for select to authenticated
  using (user_id = auth.uid());

create policy "shares_insert_own" on public.shares
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "shares_delete_own" on public.shares
  for delete to authenticated
  using (user_id = auth.uid());

-- No update policy: shares are immutable.

-- Storage: private 'exports' bucket; objects live under <user_id>/<share_id>.<ext>

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;

create policy "exports_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'exports' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "exports_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'exports' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "exports_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'exports' and (storage.foldername(name))[1] = auth.uid()::text);

-- Optional: server-side purge of expired shares. The client already purges
-- lazily on listShares(); this makes cleanup independent of user visits.
-- Requires pg_cron (available on the free tier: Database -> Extensions -> pg_cron).
--
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'inout-purge-expired-shares',
--   '17 * * * *', -- hourly
--   $$
--   delete from storage.objects
--     where bucket_id = 'exports'
--       and name in (select object_path from public.shares where expires_at < now());
--   delete from public.shares where expires_at < now();
--   $$
-- );
