import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import {
  getSessionTranscriptForFlush,
  insertMemories,
  type DbClient,
} from "@agents/db";
import type { AgentMessage, MemoryType } from "@agents/types";
import { generateEmbedding } from "./embeddings";

const DEFAULT_EXTRACTION_MODEL = "anthropic/claude-3.5-haiku";
const DEFAULT_TRANSCRIPT_LIMIT = 150;

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
}

export interface MemoryFlushInput {
  db: DbClient;
  userId: string;
  sessionId: string;
  transcript?: AgentMessage[];
}

export interface MemoryFlushResult {
  extracted: number;
  inserted: number;
  skipped: boolean;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createExtractionModel(): ChatOpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: process.env.MEMORY_EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL,
    temperature: 0,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}

function buildExtractionPrompt(transcript: string): string {
  return [
    "You extract durable long-term memories from an assistant session.",
    "Return ONLY strict JSON (no markdown, no prose) with this schema:",
    '{"memories":[{"type":"episodic|semantic|procedural","content":"..."}]}',
    "",
    "Memory types:",
    "- episodic: concrete event tied to this user (what happened and when/context).",
    "- semantic: stable preferences, facts, constraints, recurring goals.",
    "- procedural: user operating style, routines, workflows, communication habits.",
    "",
    "Conservative rules:",
    "- Keep only information likely true/useful in a future session.",
    "- Ignore small talk, temporary details, guesses, or redundant restatements.",
    "- Keep content concise and specific.",
    "- If nothing is durable, return {\"memories\":[]}.",
    "",
    "Session transcript:",
    transcript,
  ].join("\n");
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  const cleaned = stripCodeFence(raw);
  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(cleaned) as { memories?: unknown };
  } catch (error) {
    throw error;
  }
  if (!Array.isArray(parsed.memories)) return [];

  return parsed.memories
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const type = (entry as { type?: unknown }).type;
      const content = (entry as { content?: unknown }).content;
      if (
        (type !== "episodic" && type !== "semantic" && type !== "procedural") ||
        typeof content !== "string"
      ) {
        return null;
      }
      const normalized = content.trim();
      if (!normalized) return null;
      return { type, content: normalized } satisfies ExtractedMemory;
    })
    .filter((entry): entry is ExtractedMemory => Boolean(entry));
}

function normalizeMemoryKey(memory: ExtractedMemory): string {
  return `${memory.type}:${memory.content.toLowerCase()}`;
}

export function isLikelyDurableMemory(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 18) return false;
  const lowered = trimmed.toLowerCase();
  const noisyPatterns = [
    "hola",
    "gracias",
    "buenos dias",
    "ok",
    "vale",
    "de acuerdo",
  ];
  return !noisyPatterns.some((pattern) => lowered === pattern);
}

function dedupeAndFilter(memories: ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Set<string>();
  const result: ExtractedMemory[] = [];
  for (const memory of memories) {
    if (!isLikelyDurableMemory(memory.content)) continue;
    const key = normalizeMemoryKey(memory);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(memory);
  }
  return result;
}

function renderTranscript(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `[${message.role}] ${message.content}`)
    .join("\n");
}

export async function flushSessionMemories(input: MemoryFlushInput): Promise<MemoryFlushResult> {
  const transcriptLimit = parsePositiveInt(
    process.env.MEMORY_FLUSH_HISTORY_LIMIT,
    DEFAULT_TRANSCRIPT_LIMIT
  );

  const transcript =
    input.transcript ??
    (await getSessionTranscriptForFlush(input.db, input.sessionId, transcriptLimit));
  if (transcript.length === 0) {
    return { extracted: 0, inserted: 0, skipped: true };
  }

  const renderedTranscript = renderTranscript(transcript);
  if (!renderedTranscript.trim()) {
    return { extracted: 0, inserted: 0, skipped: true };
  }

  const model = createExtractionModel();
  const extractionPrompt = buildExtractionPrompt(renderedTranscript);
  const output = await model.invoke([new HumanMessage(extractionPrompt)]);
  const raw = typeof output.content === "string" ? output.content : JSON.stringify(output.content);
  let extractedParsed: ExtractedMemory[];
  try {
    extractedParsed = parseExtractedMemories(raw);
  } catch (error) {
    throw error;
  }
  const extracted = dedupeAndFilter(extractedParsed);

  if (extracted.length === 0) {
    return { extracted: 0, inserted: 0, skipped: true };
  }

  const rows = [];
  for (const memory of extracted) {
    const embedding = await generateEmbedding(memory.content);
    rows.push({
      user_id: input.userId,
      type: memory.type,
      content: memory.content,
      embedding,
    });
  }

  const inserted = await insertMemories(input.db, rows);
  return { extracted: extracted.length, inserted: inserted.length, skipped: false };
}
