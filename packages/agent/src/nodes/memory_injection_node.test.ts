import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createMemoryInjectionNode } from "./memory_injection_node";
import { generateEmbedding } from "../embeddings";
import { bumpMemoryRetrievalStats, matchMemoriesForInput } from "@agents/db";

vi.mock("../embeddings", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("@agents/db", () => ({
  matchMemoriesForInput: vi.fn(),
  bumpMemoryRetrievalStats: vi.fn(),
}));

describe("createMemoryInjectionNode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects top memories into a system block", async () => {
    vi.mocked(generateEmbedding).mockResolvedValue([0.2, 0.3]);
    vi.mocked(matchMemoriesForInput).mockResolvedValue([
      {
        id: "m1",
        user_id: "u1",
        type: "semantic",
        content: "Prefiere respuestas breves",
        retrieval_count: 1,
        created_at: new Date().toISOString(),
        similarity: 0.91,
      },
    ]);
    vi.mocked(bumpMemoryRetrievalStats).mockResolvedValue();

    const node = createMemoryInjectionNode({} as never);
    const result = await node({
      messages: [new SystemMessage("Base"), new HumanMessage("Organiza mis tareas del dia")],
      userId: "u1",
      systemPrompt: "Base",
      memoryInjected: false,
    });

    expect(result.memoryInjected).toBe(true);
    expect(result.systemPrompt).toContain("[MEMORIA DEL USUARIO]");
    expect(result.messages).toHaveLength(1);
    expect(String(result.messages?.[0].content)).toContain("Prefiere respuestas breves");
    expect(bumpMemoryRetrievalStats).toHaveBeenCalledWith(expect.anything(), ["m1"]);
  });

  it("does not fail flow when bumping retrieval stats fails", async () => {
    vi.mocked(generateEmbedding).mockResolvedValue([0.2, 0.3]);
    vi.mocked(matchMemoriesForInput).mockResolvedValue([
      {
        id: "m1",
        user_id: "u1",
        type: "procedural",
        content: "Le gusta confirmar antes de ejecutar cambios",
        retrieval_count: 2,
        created_at: new Date().toISOString(),
        similarity: 0.85,
      },
    ]);
    vi.mocked(bumpMemoryRetrievalStats).mockRejectedValue(new Error("boom"));

    const node = createMemoryInjectionNode({} as never);
    const result = await node({
      messages: [new HumanMessage("Haz cambios pero pregúntame antes")],
      userId: "u1",
      systemPrompt: "Base",
      memoryInjected: false,
    });

    expect(result.memoryInjected).toBe(true);
    expect(result.messages).toHaveLength(1);
  });

  it("skips work when memory was already injected in this session", async () => {
    const node = createMemoryInjectionNode({} as never);
    const result = await node({
      messages: [new HumanMessage("hola")],
      userId: "u1",
      systemPrompt: "Base",
      memoryInjected: true,
    });

    expect(result).toEqual({ memoryInjected: true });
    expect(generateEmbedding).not.toHaveBeenCalled();
    expect(matchMemoriesForInput).not.toHaveBeenCalled();
  });
});
