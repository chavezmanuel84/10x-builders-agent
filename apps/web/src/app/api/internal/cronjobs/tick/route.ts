import { NextResponse } from "next/server";
import {
  claimDueCronJobs,
  completeCronJobRun,
  createCronJobRun,
  createServerClient,
  createSession,
  decrypt,
  updateCronJobAfterRun,
} from "@agents/db";
import {
  buildSystemPrompt,
  flushSessionMemories,
  getNextCronRunAt,
  runAgent,
} from "@agents/agent";
import type { UserIntegration, UserToolSetting } from "@agents/types";
import { sendTelegramMessage } from "@/lib/telegram";

const CRON_SECRET_HEADER = "x-cron-secret";

interface ExecutionContext {
  systemPrompt: string;
  userTimezone: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleCalendarToken?: string;
}

async function loadExecutionContext(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<ExecutionContext> {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  let githubToken: string | undefined;
  const ghIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "github"
  );
  if (ghIntegration && (ghIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      githubToken = decrypt(
        (ghIntegration as Record<string, unknown>).encrypted_tokens as string
      );
    } catch {
      console.error("Failed to decrypt GitHub token for scheduled task", userId);
    }
  }

  let googleCalendarToken: string | undefined;
  const gcalIntegration = (integrations ?? []).find(
    (i: Record<string, unknown>) => i.provider === "google_calendar"
  );
  if (gcalIntegration && (gcalIntegration as Record<string, unknown>).encrypted_tokens) {
    try {
      googleCalendarToken = decrypt(
        (gcalIntegration as Record<string, unknown>).encrypted_tokens as string
      );
    } catch {
      console.error("Failed to decrypt Google Calendar token for scheduled task", userId);
    }
  }

  return {
    systemPrompt: buildSystemPrompt(
      (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      (profile?.timezone as string) ?? "America/Bogota"
    ),
    userTimezone: (profile?.timezone as string) ?? "UTC",
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })) as UserToolSetting[],
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })) as UserIntegration[],
    githubToken,
    googleCalendarToken,
  };
}

async function findTelegramChatId(
  db: ReturnType<typeof createServerClient>,
  userId: string
): Promise<number | null> {
  const { data } = await db
    .from("telegram_accounts")
    .select("chat_id")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.chat_id ? Number(data.chat_id) : null;
}

function ensureCronSecret(request: Request): string | null {
  const expected = process.env.CRON_TICK_SECRET?.trim();
  if (!expected) return "CRON_TICK_SECRET is not configured";
  const received = request.headers.get(CRON_SECRET_HEADER)?.trim();
  if (!received || received !== expected) return "Unauthorized";
  return null;
}

async function processTick(request: Request) {
  const authError = ensureCronSecret(request);
  if (authError) {
    return NextResponse.json({ error: authError }, { status: authError === "Unauthorized" ? 401 : 500 });
  }

  const db = createServerClient();
  const maxJobs = Number(process.env.CRON_TICK_MAX_JOBS ?? "10");
  const claimed = await claimDueCronJobs(
    db,
    Number.isFinite(maxJobs) && maxJobs > 0 ? maxJobs : 10,
    "next-internal-cron"
  );

  const processed: Array<Record<string, unknown>> = [];

  for (const cronjob of claimed) {
    const run = await createCronJobRun(db, cronjob);
    let executionStatus: "success" | "failed" = "success";
    let notificationChannel: "telegram" | "log" = "telegram";
    let notificationStatus: "pending" | "sent" | "fallback_log" | "failed" = "pending";
    let errorMessage: string | undefined;
    let responseText = "";

    try {
      const context = await loadExecutionContext(db, cronjob.user_id);
      const session = await createSession(db, cronjob.user_id, "web");

      try {
        const result = await runAgent({
          message: cronjob.task_prompt,
          userId: cronjob.user_id,
          sessionId: session.id,
          systemPrompt: context.systemPrompt,
          db,
          enabledTools: context.enabledTools,
          integrations: context.integrations,
          githubToken: context.githubToken,
          googleCalendarToken: context.googleCalendarToken,
          userTimezone: context.userTimezone,
          contextInstruction:
            "Esta ejecución fue disparada por un cronjob. Responde solo al prompt programado.",
        });

        if (result.error) {
          throw new Error(result.error);
        }
        responseText = result.pendingConfirmation
          ? result.pendingConfirmation.message
          : result.response;
      } finally {
        await db
          .from("agent_sessions")
          .update({ status: "closed", updated_at: new Date().toISOString() })
          .eq("id", session.id);

        void flushSessionMemories({
          db,
          userId: cronjob.user_id,
          sessionId: session.id,
        }).catch((error) => {
          console.error("Memory flush failed on cronjob session close", {
            userId: cronjob.user_id,
            sessionId: session.id,
            error,
          });
        });
      }

      const chatId = await findTelegramChatId(db, cronjob.user_id);
      if (chatId) {
        const msg =
          `Tarea programada: ${cronjob.job_name}\n\n` +
          `Resultado:\n${responseText || "Sin respuesta del agente."}`;
        await sendTelegramMessage(chatId, msg);
        notificationChannel = "telegram";
        notificationStatus = "sent";
      } else {
        notificationChannel = "log";
        notificationStatus = "fallback_log";
        console.info("[cronjobs] No Telegram linked; fallback log", {
          cronjob_id: cronjob.id,
          user_id: cronjob.user_id,
          run_id: run.id,
        });
      }
    } catch (err) {
      executionStatus = "failed";
      errorMessage = err instanceof Error ? err.message : "Unknown cronjob execution error";
      const chatId = await findTelegramChatId(db, cronjob.user_id);
      if (chatId) {
        try {
          await sendTelegramMessage(
            chatId,
            `Tarea programada: ${cronjob.job_name}\n\nFalló la ejecución: ${errorMessage}`
          );
          notificationChannel = "telegram";
          notificationStatus = "sent";
        } catch {
          notificationChannel = "telegram";
          notificationStatus = "failed";
        }
      } else {
        notificationChannel = "log";
        notificationStatus = "fallback_log";
        console.error("[cronjobs] Execution failed and Telegram not linked", {
          cronjob_id: cronjob.id,
          user_id: cronjob.user_id,
          run_id: run.id,
          error: errorMessage,
        });
      }
    }

    const now = new Date();
    const isOneTime = cronjob.schedule_type === "one_time";
    if (isOneTime) {
      await updateCronJobAfterRun(db, cronjob.id, {
        next_run_at: cronjob.next_run_at,
        status: executionStatus === "success" ? "completed" : "failed",
        last_error: errorMessage,
        last_executed_at: now.toISOString(),
      });
    } else {
      if (!cronjob.cron_expression) {
        throw new Error(`Recurring cronjob ${cronjob.id} has no cron_expression`);
      }
      const nextRunAt = getNextCronRunAt(
        cronjob.cron_expression,
        cronjob.timezone,
        now
      ).toISOString();
      await updateCronJobAfterRun(db, cronjob.id, {
        next_run_at: nextRunAt,
        status: "active",
        last_error: errorMessage,
        last_executed_at: now.toISOString(),
      });
    }

    await completeCronJobRun(db, run.id, {
      status: executionStatus,
      notification_channel: notificationChannel,
      notification_status: notificationStatus,
      error_message: errorMessage,
      result_json: {
        response: responseText,
        cronjob_id: cronjob.id,
        schedule_type: cronjob.schedule_type,
      },
      finished_at: new Date().toISOString(),
    });

    processed.push({
      cronjob_id: cronjob.id,
      run_id: run.id,
      status: executionStatus,
      notification_status: notificationStatus,
    });
  }

  return NextResponse.json({
    claimed: claimed.length,
    processed,
  });
}

export async function POST(request: Request) {
  return processTick(request);
}

export async function GET(request: Request) {
  return processTick(request);
}
