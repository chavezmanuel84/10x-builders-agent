-- ============================================================
-- agent_sessions: title + title_generated
-- ============================================================
-- title IS NULL means no title yet; the first user message generates one.
-- title_generated=false means the title hasn't been generated automatically yet
-- (or could be manual in the future). It is set to true when the first auto-title
-- is written so future logic can distinguish auto vs manual titles.
alter table public.agent_sessions
  add column if not exists title text,
  add column if not exists title_generated boolean not null default false;

create index if not exists agent_sessions_user_channel_created_idx
  on public.agent_sessions (user_id, channel, created_at desc);
