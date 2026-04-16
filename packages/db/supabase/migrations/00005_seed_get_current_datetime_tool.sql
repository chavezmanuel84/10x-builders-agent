-- Add get_current_datetime as a default low-risk utility tool.
-- We update handle_new_user and backfill existing users idempotently.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (new.id);

  INSERT INTO public.user_tool_settings (user_id, tool_id, enabled)
  VALUES
    (new.id, 'get_current_path', true),
    (new.id, 'change_directory', true),
    (new.id, 'get_current_datetime', true)
  ON CONFLICT (user_id, tool_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

INSERT INTO public.user_tool_settings (user_id, tool_id, enabled)
SELECT p.id, t.tool_id, true
FROM public.profiles p
CROSS JOIN (
  VALUES ('get_current_path'), ('change_directory'), ('get_current_datetime')
) AS t(tool_id)
ON CONFLICT (user_id, tool_id) DO NOTHING;
