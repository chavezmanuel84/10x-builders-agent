import type { DbClient } from "../client";
import type {
  AgentMessage,
  ConversationContextPayload,
  ConversationContextStatus,
  MessageRole,
} from "@agents/types";

export async function addMessage(
  db: DbClient,
  sessionId: string,
  role: MessageRole,
  content: string,
  extra?: {
    tool_call_id?: string;
    structured_payload?: Record<string, unknown> | ConversationContextPayload;
  }
) {
  const { data, error } = await db
    .from("agent_messages")
    .insert({ session_id: sessionId, role, content, ...extra })
    .select()
    .single();
  if (error) throw error;
  return data as AgentMessage;
}

export async function getSessionMessages(
  db: DbClient,
  sessionId: string,
  limit = 50
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AgentMessage[];
}

function asConversationPayload(
  input: unknown
): ConversationContextPayload | null {
  if (!input || typeof input !== "object") return null;
  const payload = input as Record<string, unknown>;
  if (
    (payload.context_type !== "pending_input" &&
      payload.context_type !== "pending_confirmation") ||
    typeof payload.context_status !== "string" ||
    typeof payload.tool_name !== "string"
  ) {
    return null;
  }
  return payload as unknown as ConversationContextPayload;
}

export async function getRecentPendingContexts(
  db: DbClient,
  sessionId: string,
  limit = 20
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("id, session_id, created_at, structured_payload, tool_call_id")
    .eq("session_id", sessionId)
    .eq("role", "assistant")
    .not("structured_payload", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as AgentMessage[])
    .map((row) => {
      const payload = asConversationPayload(row.structured_payload);
      if (!payload) return null;
      if (typeof row.id !== "string" || typeof row.session_id !== "string") return null;
      return {
        message_id: row.id,
        session_id: row.session_id,
        created_at: row.created_at,
        payload,
      };
    })
    .filter((row): row is {
      message_id: string;
      session_id: string;
      created_at: string;
      payload: ConversationContextPayload;
    } => Boolean(row));
}

export async function updateMessageContextStatus(
  db: DbClient,
  messageId: string,
  status: ConversationContextStatus
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("id, structured_payload")
    .eq("id", messageId)
    .single();
  if (error) throw error;
  const payload = asConversationPayload(data?.structured_payload);
  if (!payload) return;

  const nextPayload: ConversationContextPayload = {
    ...payload,
    context_status: status,
  };

  const { error: updateError } = await db
    .from("agent_messages")
    .update({ structured_payload: nextPayload })
    .eq("id", messageId);
  if (updateError) throw updateError;
}

export async function closeActiveContextsByToolCallId(
  db: DbClient,
  sessionId: string,
  toolCallId: string,
  status: Exclude<ConversationContextStatus, "active">
) {
  const { data, error } = await db
    .from("agent_messages")
    .select("id, structured_payload")
    .eq("session_id", sessionId)
    .eq("tool_call_id", toolCallId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  for (const row of (data ?? []) as AgentMessage[]) {
    const payload = asConversationPayload(row.structured_payload);
    if (!payload || payload.context_status !== "active") continue;
    const nextPayload: ConversationContextPayload = {
      ...payload,
      context_status: status,
    };
    const { error: updateError } = await db
      .from("agent_messages")
      .update({ structured_payload: nextPayload })
      .eq("id", row.id);
    if (updateError) throw updateError;
  }
}
