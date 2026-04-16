import type { DbClient } from "../client";
import type {
  CronJob,
  CronJobNotificationChannel,
  CronJobNotificationStatus,
  CronJobRun,
  CronJobRunStatus,
  CronJobScheduleType,
  CronJobStatus,
} from "@agents/types";

export interface CreateCronJobInput {
  job_name: string;
  description?: string;
  schedule_type?: CronJobScheduleType;
  cron_expression?: string;
  one_time_run_at?: string;
  task_prompt: string;
  timezone: string;
  next_run_at: string;
  status?: CronJobStatus;
}

export interface CompleteCronJobRunInput {
  status: CronJobRunStatus;
  notification_channel: CronJobNotificationChannel;
  notification_status: CronJobNotificationStatus;
  result_json?: Record<string, unknown>;
  error_message?: string;
  finished_at?: string;
}

export async function createCronJob(
  db: DbClient,
  userId: string,
  input: CreateCronJobInput
) {
  const { data, error } = await db
    .from("cronjobs")
    .insert({
      user_id: userId,
      job_name: input.job_name,
      description: input.description ?? "",
      schedule_type: input.schedule_type ?? "recurring",
      cron_expression: input.cron_expression ?? null,
      one_time_run_at: input.one_time_run_at ?? null,
      task_prompt: input.task_prompt,
      timezone: input.timezone,
      next_run_at: input.next_run_at,
      status: input.status ?? "active",
    })
    .select()
    .single();
  if (error) throw error;
  return data as CronJob;
}

export async function claimDueCronJobs(
  db: DbClient,
  maxJobs = 10,
  runnerId = "next-cron"
) {
  const { data, error } = await db.rpc("claim_due_cronjobs", {
    max_jobs: maxJobs,
    runner_id: runnerId,
  });
  if (error) throw error;
  return (data ?? []) as CronJob[];
}

export async function createCronJobRun(
  db: DbClient,
  cronjob: Pick<CronJob, "id" | "user_id" | "next_run_at">
) {
  const { data, error } = await db
    .from("cronjobs_runs")
    .insert({
      cronjob_id: cronjob.id,
      user_id: cronjob.user_id,
      scheduled_for: cronjob.next_run_at,
      status: "running",
      notification_channel: "telegram",
      notification_status: "pending",
    })
    .select()
    .single();
  if (error) throw error;
  return data as CronJobRun;
}

export async function completeCronJobRun(
  db: DbClient,
  runId: string,
  input: CompleteCronJobRunInput
) {
  const { data, error } = await db
    .from("cronjobs_runs")
    .update({
      status: input.status,
      notification_channel: input.notification_channel,
      notification_status: input.notification_status,
      result_json: input.result_json ?? {},
      error_message: input.error_message ?? null,
      finished_at: input.finished_at ?? new Date().toISOString(),
    })
    .eq("id", runId)
    .select()
    .single();
  if (error) throw error;
  return data as CronJobRun;
}

interface UpdateCronJobAfterRunInput {
  next_run_at: string;
  status?: CronJobStatus;
  last_error?: string;
  last_executed_at?: string;
}

export async function updateCronJobAfterRun(
  db: DbClient,
  cronjobId: string,
  input: UpdateCronJobAfterRunInput
) {
  const { data, error } = await db
    .from("cronjobs")
    .update({
      next_run_at: input.next_run_at,
      status: input.status ?? "active",
      last_error: input.last_error ?? null,
      last_executed_at: input.last_executed_at ?? new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cronjobId)
    .select()
    .single();
  if (error) throw error;
  return data as CronJob;
}

export async function markCronJobFailed(
  db: DbClient,
  cronjobId: string,
  errorMessage: string
) {
  const { data, error } = await db
    .from("cronjobs")
    .update({
      status: "failed",
      last_error: errorMessage,
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cronjobId)
    .select()
    .single();
  if (error) throw error;
  return data as CronJob;
}
