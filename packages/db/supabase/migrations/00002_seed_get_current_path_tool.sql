-- Seed get_current_path tool setting for all existing users.
-- New users receive it automatically via the handle_new_user trigger
-- (which should also be updated to insert this row on signup).
-- ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.
INSERT INTO public.user_tool_settings (user_id, tool_id, enabled)
SELECT id, 'get_current_path', true
FROM public.profiles
ON CONFLICT (user_id, tool_id) DO NOTHING;
