# Security: RLS and access (no one sees data unless added by owner)

**Rule:** If user A did not add user B, B can never see A’s data. Permissions (e.g. read-only) come later. This doc defines how to close all weakness potential in Supabase.

---

## 1. Schema requirement

**`channel_members`** must have:

- `channel` (text)
- `user_id` (uuid, references auth.users)
- `creator_id` (uuid, references auth.users) — **who added this member**
- PK or unique: `(channel, user_id)`

**Channel owner** = the user who created the channel = the row where `user_id = creator_id` for that channel. Only the owner may add or remove members (except users may remove themselves).

If `creator_id` is missing, add it and backfill: set `creator_id = user_id` for existing rows (each member was their own “creator” until we had the column).

---

## 2. RLS: `entries`

- **SELECT**: `user_id = auth.uid()` OR `(channel, auth.uid())` IN (SELECT channel, user_id FROM channel_members).  
  So: own rows (Main) or rows in channels where you are a member.
- **INSERT**: `user_id = auth.uid()` AND (channel = 'main' OR (channel, auth.uid()) IN channel_members).  
  So: you can only send in Main or in channels you’re in.
- **UPDATE / DELETE**: Same as SELECT for the row (only owner or member of that channel can change/delete).

This prevents anyone from reading or writing entries they weren’t granted access to via channel_members.

---

## 3. RLS: `channel_members` (prevents “see-through” and unauthorized add)

- **SELECT**:  
  `user_id = auth.uid()`  
  OR  
  EXISTS (SELECT 1 FROM channel_members cm2 WHERE cm2.channel = channel_members.channel AND cm2.user_id = auth.uid()).  
  So: you see your own memberships and all members of channels you’re in (needed for UI).
- **INSERT**:  
  `creator_id = auth.uid()`  
  AND  
  (  
    `user_id = auth.uid()`  
    OR  
    EXISTS (SELECT 1 FROM channel_members cm2 WHERE cm2.channel = channel_members.channel AND cm2.user_id = auth.uid() AND cm2.creator_id = auth.uid())  
  ).  
  So: you can add yourself to a new channel (creator = you, user = you), or add someone else only if you are already the channel owner (you have a row in that channel with user_id = creator_id = you).
- **UPDATE**: Restrict to owner if you ever need it; otherwise deny or same as INSERT.
- **DELETE**: `user_id = auth.uid()` (leave channel) OR (channel owner removing someone — optional for “remove member” later).  
  So: at minimum users can delete their own row; optionally allow owner to delete other users’ rows for that channel.

This prevents user B (added by A) from adding user C to A’s channel. Only A can add members.

---

## 4. RLS: `views`

- **SELECT / INSERT / UPDATE / DELETE**: `user_id = auth.uid()` only.  
  So: each user only sees and changes their own view config.

---

## 5. RLS: `message_orders` (if still used)

- **SELECT / INSERT / UPDATE / DELETE**: `user_id = auth.uid()` only.

---

## 6. Other tables

- **`action_log`** (if used): `user_id = auth.uid()` only.
- Any future table that holds user or channel data: scope by `user_id` or by membership via `channel_members` with the same “only creator can add members” rule.

---

## 7. Client

- App already sends `creator_id: currentUser.id` when creating a channel or adding members (index.html). No change needed there.
- Never trust the client for enforcement: RLS is the single source of truth. Client checks (e.g. “only show Share if I’m owner”) are for UX only.

---

## 8. Checklist (Supabase dashboard / SQL)

1. Run the SQL below in Supabase SQL Editor (or use Supabase MCP `apply_migration` with project_id). Requires: entries, channel_members, views. Optional: omit the `message_orders` block if that table does not exist.
2. Test: as user A, create channel, add B. As B, try to add C via API or SQL — must fail. As C (never added by A), try to read A’s channel entries — must return no rows.

---

## 9. Runnable SQL (copy to Supabase SQL Editor)

```sql
-- 1. SCHEMA: channel_members.creator_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channel_members' AND column_name = 'creator_id'
  ) THEN
    ALTER TABLE public.channel_members ADD COLUMN creator_id uuid REFERENCES auth.users(id);
  END IF;
END $$;

UPDATE public.channel_members SET creator_id = user_id WHERE creator_id IS NULL;

-- 2. ENABLE RLS
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_orders ENABLE ROW LEVEL SECURITY;

-- 3. DROP EXISTING NAMED POLICIES
DROP POLICY IF EXISTS rls_entries_select ON public.entries;
DROP POLICY IF EXISTS rls_entries_insert ON public.entries;
DROP POLICY IF EXISTS rls_entries_update ON public.entries;
DROP POLICY IF EXISTS rls_entries_delete ON public.entries;
DROP POLICY IF EXISTS rls_channel_members_select ON public.channel_members;
DROP POLICY IF EXISTS rls_channel_members_insert ON public.channel_members;
DROP POLICY IF EXISTS rls_channel_members_delete ON public.channel_members;
DROP POLICY IF EXISTS rls_views_select ON public.views;
DROP POLICY IF EXISTS rls_views_insert ON public.views;
DROP POLICY IF EXISTS rls_views_update ON public.views;
DROP POLICY IF EXISTS rls_views_delete ON public.views;
DROP POLICY IF EXISTS rls_message_orders_select ON public.message_orders;
DROP POLICY IF EXISTS rls_message_orders_insert ON public.message_orders;
DROP POLICY IF EXISTS rls_message_orders_update ON public.message_orders;
DROP POLICY IF EXISTS rls_message_orders_delete ON public.message_orders;

-- 4. ENTRIES
CREATE POLICY rls_entries_select ON public.entries FOR SELECT USING (
  (user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel = entries.channel AND cm.user_id = auth.uid())
);
CREATE POLICY rls_entries_insert ON public.entries FOR INSERT WITH CHECK (
  user_id = auth.uid() AND (channel = 'main' OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel = entries.channel AND cm.user_id = auth.uid()))
);
CREATE POLICY rls_entries_update ON public.entries FOR UPDATE USING (
  (user_id = auth.uid()) OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel = entries.channel AND cm.user_id = auth.uid())
);
CREATE POLICY rls_entries_delete ON public.entries FOR DELETE USING (
  (user_id = auth.uid()) OR EXISTS (SELECT 1 FROM public.channel_members cm WHERE cm.channel = entries.channel AND cm.user_id = auth.uid())
);

-- 5. CHANNEL_MEMBERS
CREATE POLICY rls_channel_members_select ON public.channel_members FOR SELECT USING (
  (user_id = auth.uid()) OR EXISTS (SELECT 1 FROM public.channel_members cm2 WHERE cm2.channel = channel_members.channel AND cm2.user_id = auth.uid())
);
CREATE POLICY rls_channel_members_insert ON public.channel_members FOR INSERT WITH CHECK (
  creator_id = auth.uid() AND (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.channel_members cm2 WHERE cm2.channel = channel_members.channel AND cm2.user_id = auth.uid() AND cm2.creator_id = auth.uid()))
);
CREATE POLICY rls_channel_members_delete ON public.channel_members FOR DELETE USING (
  (user_id = auth.uid()) OR EXISTS (SELECT 1 FROM public.channel_members cm2 WHERE cm2.channel = channel_members.channel AND cm2.user_id = auth.uid() AND cm2.creator_id = auth.uid())
);

-- 6. VIEWS
CREATE POLICY rls_views_select ON public.views FOR SELECT USING (user_id = auth.uid());
CREATE POLICY rls_views_insert ON public.views FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY rls_views_update ON public.views FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY rls_views_delete ON public.views FOR DELETE USING (user_id = auth.uid());

-- 7. MESSAGE_ORDERS (comment out if table does not exist)
CREATE POLICY rls_message_orders_select ON public.message_orders FOR SELECT USING (user_id = auth.uid());
CREATE POLICY rls_message_orders_insert ON public.message_orders FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY rls_message_orders_update ON public.message_orders FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY rls_message_orders_delete ON public.message_orders FOR DELETE USING (user_id = auth.uid());
```
