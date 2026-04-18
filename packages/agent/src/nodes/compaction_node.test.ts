import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createCompactionNode } from "./compaction_node";

function withEnv(updates: Record<string, string>, fn: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

describe("createCompactionNode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("microcompacts old tool results while preserving latest five", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "test-key",
        COMPACTION_CONTEXT_WINDOW_TOKENS: "1000000",
        COMPACTION_KEEP_RECENT_TOOL_RESULTS: "5",
      },
      async () => {
        const node = createCompactionNode();
        const messages: BaseMessage[] = [
          new SystemMessage("sys"),
          new HumanMessage("h1"),
          new AIMessage("a1"),
          ...Array.from({ length: 7 }, (_, i) =>
            new ToolMessage({
              content: `tool_result_${i}`,
              tool_call_id: `call_${i}`,
            })
          ),
        ];

        const result = await node({ messages, compactionCount: 0 });
        expect(result.messages).toBeDefined();
        const tools = (result.messages ?? []).filter((m) => m instanceof ToolMessage) as ToolMessage[];
        expect(tools).toHaveLength(7);
        expect(String(tools[0].content)).toBe("[tool result cleared]");
        expect(String(tools[1].content)).toBe("[tool result cleared]");
        expect(String(tools[2].content)).toBe("tool_result_2");
        expect(String(tools[6].content)).toBe("tool_result_6");
      }
    );
  });

  it("bypasses compaction when circuit breaker is open", async () => {
    await withEnv({ OPENROUTER_API_KEY: "test-key" }, async () => {
      const node = createCompactionNode();
      const result = await node({
        messages: [new HumanMessage("hola")],
        compactionCount: 3,
      });
      expect(result).toEqual({});
    });
  });

  it("runs LLM compaction, strips analysis block and resets counter", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "test-key",
        COMPACTION_CONTEXT_WINDOW_TOKENS: "50",
        COMPACTION_RECENT_TAIL_MESSAGES: "2",
      },
      async () => {
        vi.spyOn(ChatOpenAI.prototype, "invoke").mockResolvedValue(
          new AIMessage(
            "<analysis>scratchpad</analysis>\n1) Session objective\n- Keep context"
          ) as never
        );
        const node = createCompactionNode();
        const result = await node({
          messages: [
            new SystemMessage("system"),
            new HumanMessage("A".repeat(500)),
            new AIMessage("B".repeat(500)),
            new HumanMessage("tail_user"),
            new AIMessage("tail_ai"),
          ],
          compactionCount: 2,
        });

        const output = result.messages ?? [];
        const summary = output.find(
          (m) => m instanceof SystemMessage && String(m.content).includes("[compaction summary]")
        );

        expect(summary).toBeTruthy();
        expect(String(summary?.content)).not.toContain("<analysis>");
        expect(result.compactionCount).toBe(0);
      }
    );
  });

  it("increments failures and stops modifying messages on third failure", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: "test-key",
        COMPACTION_CONTEXT_WINDOW_TOKENS: "50",
        COMPACTION_RECENT_TAIL_MESSAGES: "1",
      },
      async () => {
        vi.spyOn(ChatOpenAI.prototype, "invoke").mockRejectedValue(new Error("network"));
        const node = createCompactionNode();
        const result = await node({
          messages: [
            new HumanMessage("A".repeat(500)),
            new AIMessage("B".repeat(500)),
            new HumanMessage("C".repeat(500)),
          ],
          compactionCount: 2,
        });

        expect(result.compactionCount).toBe(3);
        expect(result.messages).toBeUndefined();
      }
    );
  });
});
