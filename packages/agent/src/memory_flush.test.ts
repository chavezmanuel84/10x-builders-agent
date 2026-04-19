import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { flushSessionMemories, parseExtractedMemories } from "./memory_flush";
import { generateEmbedding } from "./embeddings";
import { insertMemories } from "@agents/db";

vi.mock("./embeddings", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("@agents/db", () => ({
  getSessionTranscriptForFlush: vi.fn(),
  insertMemories: vi.fn(),
}));

describe("memory_flush", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("parses strict JSON and skips invalid entries", () => {
    const parsed = parseExtractedMemories(`\`\`\`json
{"memories":[{"type":"semantic","content":"Prefiere respuestas concretas"},{"type":"bad","content":"X"},{"type":"procedural","content":"  Sigue rutina diaria  "}]}
\`\`\``);

    expect(parsed).toEqual([
      { type: "semantic", content: "Prefiere respuestas concretas" },
      { type: "procedural", content: "Sigue rutina diaria" },
    ]);
  });

  it("dedupes and filters noisy memories before insert", async () => {
    vi.spyOn(ChatOpenAI.prototype, "invoke").mockResolvedValue(
      new AIMessage(
        '{"memories":[{"type":"semantic","content":"Prefiere respuestas breves y directas"},{"type":"semantic","content":"Prefiere respuestas breves y directas"},{"type":"episodic","content":"ok"}]}'
      ) as never
    );
    vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(insertMemories).mockImplementation(async (_db, rows) =>
      rows.map((row, index) => ({
        id: `m-${index}`,
        user_id: row.user_id,
        type: row.type,
        content: row.content,
        retrieval_count: 0,
        created_at: new Date().toISOString(),
      }))
    );

    const result = await flushSessionMemories({
      db: {} as never,
      userId: "user-1",
      sessionId: "session-1",
      transcript: [
        {
          id: "1",
          session_id: "session-1",
          role: "user",
          content: "Necesito que mis respuestas sean breves",
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          session_id: "session-1",
          role: "assistant",
          content: "Perfecto, respuestas breves desde ahora.",
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(result).toEqual({ extracted: 1, inserted: 1, skipped: false });
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    expect(insertMemories).toHaveBeenCalledTimes(1);
  });

  it("skips when transcript is empty", async () => {
    const result = await flushSessionMemories({
      db: {} as never,
      userId: "user-1",
      sessionId: "session-1",
      transcript: [],
    });

    expect(result).toEqual({ extracted: 0, inserted: 0, skipped: true });
  });
});
