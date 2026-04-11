import type { DbClient } from "../client";
import type { AgentSession, Channel } from "@agents/types";
import {
  closeActiveContextsForSession,
} from "./messages";
import {
  closePendingConfirmationToolCallsForSession,
} from "./tool-calls";

export async function createSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data, error } = await db
    .from("agent_sessions")
    .insert({
      user_id: userId,
      channel,
      status: "active",
      budget_tokens_used: 0,
      budget_tokens_limit: 100000,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentSession;
}

export async function getActiveSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data } = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as AgentSession | null;
}

export async function closeActiveSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data: sessions, error } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const activeSessions = (sessions ?? []) as Array<{ id: string }>;
  if (activeSessions.length === 0) return [] as string[];

  const now = new Date().toISOString();
  for (const session of activeSessions) {
    await closeActiveContextsForSession(db, session.id);
    await closePendingConfirmationToolCallsForSession(db, session.id, "new_session_started");
    const { error: updateError } = await db
      .from("agent_sessions")
      .update({ status: "closed", updated_at: now })
      .eq("id", session.id)
      .eq("status", "active");
    if (updateError) throw updateError;
  }

  return activeSessions.map((session) => session.id);
}

export async function startNewSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  await closeActiveSession(db, userId, channel);
  return createSession(db, userId, channel);
}

export async function getOrCreateSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const existing = await getActiveSession(db, userId, channel);
  if (existing) return existing;
  return createSession(db, userId, channel);
}

export async function updateSessionTokens(
  db: DbClient,
  sessionId: string,
  tokensUsed: number
) {
  const { error } = await db
    .from("agent_sessions")
    .update({
      budget_tokens_used: tokensUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}
