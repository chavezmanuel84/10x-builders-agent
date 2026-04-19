import type { DbClient } from "../client";
import type { AgentMessage, MemoryRow, MemoryType } from "@agents/types";

export interface NewMemory {
  user_id: string;
  type: MemoryType;
  content: string;
  embedding: number[];
}

export interface RetrievedMemory extends MemoryRow {
  similarity: number;
}

export async function insertMemories(
  db: DbClient,
  rows: NewMemory[]
): Promise<MemoryRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await db.from("memories").insert(rows).select("*");
  if (error) throw error;
  return (data ?? []) as MemoryRow[];
}

export async function getSessionTranscriptForFlush(
  db: DbClient,
  sessionId: string,
  limit = 150
): Promise<AgentMessage[]> {
  const { data, error } = await db
    .from("agent_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as AgentMessage[]).reverse();
}

export async function matchMemoriesForInput(
  db: DbClient,
  args: {
    userId: string;
    embedding: number[];
    matchCount?: number;
    matchThreshold?: number;
  }
): Promise<RetrievedMemory[]> {
  const { data, error } = await db.rpc("match_memories", {
    p_user_id: args.userId,
    query_embedding: args.embedding,
    match_count: args.matchCount ?? 8,
    match_threshold: args.matchThreshold ?? 0.7,
  });
  if (error) throw error;
  return (data ?? []) as RetrievedMemory[];
}

export async function bumpMemoryRetrievalStats(
  db: DbClient,
  memoryIds: string[]
): Promise<void> {
  const uniqueIds = [...new Set(memoryIds)].filter(Boolean);
  if (uniqueIds.length === 0) return;

  const nowIso = new Date().toISOString();
  for (const memoryId of uniqueIds) {
    const { data: memory, error: selectError } = await db
      .from("memories")
      .select("retrieval_count")
      .eq("id", memoryId)
      .single();
    if (selectError) throw selectError;

    const nextCount =
      typeof memory?.retrieval_count === "number" ? memory.retrieval_count + 1 : 1;
    const { error: updateError } = await db
      .from("memories")
      .update({
        retrieval_count: nextCount,
        last_retrieved_at: nowIso,
      })
      .eq("id", memoryId);
    if (updateError) throw updateError;
  }
}
