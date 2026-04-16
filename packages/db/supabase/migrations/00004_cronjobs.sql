-- ============================================================
-- cronjobs (scheduled tasks)
-- ============================================================
create table public.cronjobs (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  job_name         text not null,
  description      text not null default '',
  cron_expression  text not null,
  task_prompt      text not null,
  timezone         text not null default 'UTC',
  status           text not null default 'active'
    check (status in ('active', 'paused', 'failed')),
  last_executed_at timestamptz,
  next_run_at      timestamptz not null,
  last_error       text,
  locked_at        timestamptz,
  locked_by        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.cronjobs enable row level security;

create policy "Users can manage own cronjobs"
  on public.cronjobs for all
  using (auth.uid() = user_id);

create index cronjobs_status_next_run_idx
  on public.cronjobs (status, next_run_at);

create index cronjobs_due_active_idx
  on public.cronjobs (next_run_at)
  where status = 'active';

-- ============================================================
-- cronjobs_runs (execution audit trail)
-- ============================================================
create table public.cronjobs_runs (
  id                   uuid primary key default uuid_generate_v4(),
  cronjob_id           uuid not null references public.cronjobs(id) on delete cascade,
  user_id              uuid not null references public.profiles(id) on delete cascade,
  scheduled_for        timestamptz not null,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  status               text not null default 'running'
    check (status in ('running', 'success', 'failed')),
  agent_session_id     uuid references public.agent_sessions(id) on delete set null,
  notification_channel text not null default 'telegram'
    check (notification_channel in ('telegram', 'log')),
  notification_status  text not null default 'pending'
    check (notification_status in ('pending', 'sent', 'fallback_log', 'failed')),
  error_message        text,
  result_json          jsonb not null default '{}',
  created_at           timestamptz not null default now()
);

alter table public.cronjobs_runs enable row level security;

create policy "Users can view own cronjob runs"
  on public.cronjobs_runs for select
  using (auth.uid() = user_id);

create index cronjobs_runs_cronjob_started_idx
  on public.cronjobs_runs (cronjob_id, started_at desc);

create index cronjobs_runs_status_started_idx
  on public.cronjobs_runs (status, started_at desc);

-- ============================================================
-- claim_due_cronjobs
-- Claims due cronjobs atomically using row-level locks.
-- Intended for service-role use from a trusted cron endpoint.
-- ============================================================
create or replace function public.claim_due_cronjobs(
  max_jobs integer default 10,
  runner_id text default 'next-cron'
)
returns setof public.cronjobs
language sql
volatile
as $$
  with picked as (
    select id
    from public.cronjobs
    where status = 'active'
      and next_run_at <= now()
      and (locked_at is null or locked_at < now() - interval '10 minutes')
    order by next_run_at asc
    limit greatest(max_jobs, 1)
    for update skip locked
  )
  update public.cronjobs c
  set locked_at = now(),
      locked_by = runner_id,
      updated_at = now()
  from picked
  where c.id = picked.id
  returning c.*;
$$;
