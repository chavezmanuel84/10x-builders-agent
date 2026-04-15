import type { DbClient } from "../client";
import type { ToolCall } from "@agents/types";

export async function createToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean
) {
  const { data, error } = await db
    .from("tool_calls")
    .insert({
      session_id: sessionId,
      tool_name: toolName,
      arguments_json: args,
      status: requiresConfirmation ? "pending_confirmation" : "approved",
      requires_confirmation: requiresConfirmation,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}

export async function updateToolCallStatus(
  db: DbClient,
  toolCallId: string,
  status: ToolCall["status"],
  resultJson?: Record<string, unknown>,
  sessionId?: string
) {
  const update: Record<string, unknown> = { status };
  if (resultJson) update.result_json = resultJson;
  if (status === "executed" || status === "failed" || status === "rejected") {
    update.finished_at = new Date().toISOString();
  }
  let query = db
    .from("tool_calls")
    .update(update)
    .eq("id", toolCallId);
  if (sessionId) {
    query = query.eq("session_id", sessionId);
  }
  const { error } = await query;
  if (error) throw error;
}

export async function getPendingToolCall(
  db: DbClient,
  toolCallId: string,
  sessionId?: string
) {
  let query = db
    .from("tool_calls")
    .select("*")
    .eq("id", toolCallId)
    .eq("status", "pending_confirmation");
  if (sessionId) {
    query = query.eq("session_id", sessionId);
  }
  const { data } = await query.single();
  return data as ToolCall | null;
}

export async function getExistingPendingToolCallForSession(
  db: DbClient,
  sessionId: string,
  toolName: string
) {
  const { data } = await db
    .from("tool_calls")
    .select("*")
    .eq("session_id", sessionId)
    .eq("tool_name", toolName)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as ToolCall | null;
}

export async function closePendingConfirmationToolCallsForSession(
  db: DbClient,
  sessionId: string,
  reason: string
) {
  const { data, error } = await db
    .from("tool_calls")
    .select("id, result_json")
    .eq("session_id", sessionId)
    .eq("status", "pending_confirmation");
  if (error) throw error;

  const now = new Date().toISOString();
  for (const row of (data ?? []) as Array<{ id: string; result_json?: Record<string, unknown> }>) {
    const currentResult =
      row.result_json && typeof row.result_json === "object" ? row.result_json : {};
    const nextResult: Record<string, unknown> = {
      ...currentResult,
      closed_reason: reason,
      closed_by: "session_reset",
    };
    const { error: updateError } = await db
      .from("tool_calls")
      .update({
        status: "rejected",
        result_json: nextResult,
        finished_at: now,
      })
      .eq("id", row.id)
      .eq("session_id", sessionId)
      .eq("status", "pending_confirmation");
    if (updateError) throw updateError;
  }
}
