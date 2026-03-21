-- Run as one script after 20260321200000_perform_entry_action_match_rpc.sql (see ../README.md).
-- Safe to re-run. Also drops the 4-arg overload if it still exists (PostgREST PGRST203).
DROP FUNCTION IF EXISTS public.perform_entry_action(text, bigint, text, jsonb);

-- Problems fixed:
-- 1) RPC returned success when UPDATE/DELETE matched 0 rows (edits looked saved, DB unchanged).
-- 2) INSERT into entry_actions could fail and roll back the whole function, undoing the UPDATE.
--
-- Client still prefers REST .update for signed-in edits; this makes the RPC fallback honest and durable.

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
DECLARE
  v_rc bigint;
BEGIN
  IF p_action = 'edit' THEN
    UPDATE public.entries
    SET text = COALESCE(p_payload->>'text', '')
    WHERE id = p_entry_id
      AND (
        channel = p_channel
        OR (p_temp_session_id IS NOT NULL AND temp_session_id = p_temp_session_id)
      );
    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc = 0 THEN
      RAISE EXCEPTION 'perform_entry_action: no entry matched for edit'
        USING ERRCODE = 'P0001';
    END IF;

  ELSIF p_action = 'delete' THEN
    DELETE FROM public.entries
    WHERE id = p_entry_id
      AND (
        channel = p_channel
        OR (p_temp_session_id IS NOT NULL AND temp_session_id = p_temp_session_id)
      );
    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc = 0 THEN
      RAISE EXCEPTION 'perform_entry_action: no entry matched for delete'
        USING ERRCODE = 'P0001';
    END IF;

  ELSIF p_action = 'move' THEN
    UPDATE public.entries
    SET
      channel = COALESCE(NULLIF(TRIM(p_payload->>'target_channel'), ''), channel),
      created_at = NOW()
    WHERE id = p_entry_id
      AND (
        channel = p_channel
        OR (p_temp_session_id IS NOT NULL AND temp_session_id = p_temp_session_id)
      );
    GET DIAGNOSTICS v_rc = ROW_COUNT;
    IF v_rc = 0 THEN
      RAISE EXCEPTION 'perform_entry_action: no entry matched for move'
        USING ERRCODE = 'P0001';
    END IF;

  ELSE
    RAISE EXCEPTION 'perform_entry_action: unknown action %', p_action
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.entry_actions(channel, entry_id, action, payload, actor_id)
    VALUES (
      p_channel,
      p_entry_id,
      p_action,
      COALESCE(p_payload, '{}'::jsonb),
      NULLIF(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'perform_entry_action: entry_actions insert skipped: %', SQLERRM;
  END;
END;
$function$;
