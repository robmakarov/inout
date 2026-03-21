-- Client sends p_temp_session_id; PostgREST rejects RPC calls with extra keys unless the
-- function declares that parameter.
-- Match rows by (id + channel) OR (id + temp_session) so shared/temp rows still update if
-- UI channel string drifted. Requires column public.entries.temp_session_id (nullable uuid).
-- If that column does not exist, remove the "or (p_temp_session_id..." clauses and keep only
-- `where id = p_entry_id and channel = p_channel`, but still add the 5th parameter.
--
-- PGRST203: if both 4-arg and 5-arg overloads exist, PostgREST cannot pick one. Drop the old signature:
DROP FUNCTION IF EXISTS public.perform_entry_action(text, bigint, text, jsonb);

CREATE OR REPLACE FUNCTION public.perform_entry_action(
  p_channel text,
  p_entry_id bigint,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_temp_session_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
begin
  if p_action = 'edit' then
    update public.entries
      set text = coalesce(p_payload->>'text', '')
    where id = p_entry_id
      and (
        channel = p_channel
        or (p_temp_session_id is not null and temp_session_id = p_temp_session_id)
      );

  elsif p_action = 'delete' then
    delete from public.entries
    where id = p_entry_id
      and (
        channel = p_channel
        or (p_temp_session_id is not null and temp_session_id = p_temp_session_id)
      );

  end if;

  insert into public.entry_actions(channel, entry_id, action, payload, actor_id)
  values (
    p_channel,
    p_entry_id,
    p_action,
    coalesce(p_payload, '{}'::jsonb),
    nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid
  );
end;
$function$;
