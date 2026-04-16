-- Replace handle_new_user to also seed default tool settings on signup.
-- The trigger binding (on_auth_user_created) is unchanged — CREATE OR REPLACE
-- updates the function body in place without touching the trigger definition.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (new.id);

  -- Seed tools that must be available to every user from their first session.
  -- A single multi-row INSERT is atomic and idempotent (ON CONFLICT DO NOTHING).
  INSERT INTO public.user_tool_settings (user_id, tool_id, enabled)
  VALUES
    (new.id, 'get_current_path',  true),
    (new.id, 'change_directory',  true)
  ON CONFLICT (user_id, tool_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------
-- Backfill existing users.
--
-- 00002 already inserted get_current_path for everyone who existed
-- at that point, but change_directory was added later. This fills
-- the gap for all profiles rows that are still missing either tool.
-- ON CONFLICT DO NOTHING makes this safe to re-run at any time.
-- ---------------------------------------------------------------
INSERT INTO public.user_tool_settings (user_id, tool_id, enabled)
SELECT p.id, t.tool_id, true
FROM public.profiles p
CROSS JOIN (
  VALUES ('get_current_path'), ('change_directory')
) AS t(tool_id)
ON CONFLICT (user_id, tool_id) DO NOTHING;
