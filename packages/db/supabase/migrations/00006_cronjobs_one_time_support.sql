-- Add schedule type support to cronjobs:
-- - recurring (existing behavior)
-- - one_time (runs once, then completes)

alter table public.cronjobs
  add column if not exists schedule_type text not null default 'recurring',
  add column if not exists one_time_run_at timestamptz;

alter table public.cronjobs
  alter column cron_expression drop not null;

alter table public.cronjobs
  drop constraint if exists cronjobs_status_check;

alter table public.cronjobs
  add constraint cronjobs_status_check
  check (status in ('active', 'paused', 'failed', 'completed'));

alter table public.cronjobs
  drop constraint if exists cronjobs_schedule_type_check;

alter table public.cronjobs
  add constraint cronjobs_schedule_type_check
  check (schedule_type in ('recurring', 'one_time'));

alter table public.cronjobs
  drop constraint if exists cronjobs_schedule_fields_check;

alter table public.cronjobs
  add constraint cronjobs_schedule_fields_check
  check (
    (schedule_type = 'recurring' and cron_expression is not null and one_time_run_at is null)
    or
    (schedule_type = 'one_time' and one_time_run_at is not null)
  );

create index if not exists cronjobs_schedule_type_status_idx
  on public.cronjobs (schedule_type, status);
