import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import {
  bumpMemoryRetrievalStats,
  matchMemoriesForInput,
  type DbClient,
  type RetrievedMemory,
} from "@agents/db";
import { generateEmbedding } from "../embeddings";

const DEFAULT_MATCH_COUNT = 6;
const DEFAULT_MATCH_THRESHOLD = 0.7;
const DEFAULT_FALLBACK_MATCH_THRESHOLD = 0.35;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function extractLastUserInput(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg instanceof HumanMessage && typeof msg.content === "string" && msg.content.trim()) {
      return msg.content.trim();
    }
  }
  return "";
}

function formatMemoryBlock(memories: RetrievedMemory[]): string {
  const lines = memories.map((memory) => `- (${memory.type}) ${memory.content}`);
  return ["[MEMORIA DEL USUARIO]", ...lines].join("\n");
}

export function createMemoryInjectionNode(db: DbClient) {
  return async function memoryInjectionNode(state: {
    messages: BaseMessage[];
    userId: string;
    systemPrompt: string;
    memoryInjected?: boolean;
  }): Promise<{
    messages?: BaseMessage[];
    systemPrompt?: string;
    memoryInjected: boolean;
  }> {
    if (state.memoryInjected) return { memoryInjected: true };

    const userInput = extractLastUserInput(state.messages);
    if (!userInput || !state.userId) return { memoryInjected: true };

    try {
      const matchCount = parsePositiveInt(
        process.env.MEMORY_INJECTION_TOP_K,
        DEFAULT_MATCH_COUNT
      );
      const matchThreshold = parseThreshold(
        process.env.MEMORY_INJECTION_THRESHOLD,
        DEFAULT_MATCH_THRESHOLD
      );
      const embedding = await generateEmbedding(userInput);
      const memories = await matchMemoriesForInput(db, {
        userId: state.userId,
        embedding,
        matchCount,
        matchThreshold,
      });

      let selectedMemories = memories;
      if (selectedMemories.length === 0 && matchThreshold > DEFAULT_FALLBACK_MATCH_THRESHOLD) {
        const fallbackThreshold = parseThreshold(
          process.env.MEMORY_INJECTION_FALLBACK_THRESHOLD,
          DEFAULT_FALLBACK_MATCH_THRESHOLD
        );
        selectedMemories = await matchMemoriesForInput(db, {
          userId: state.userId,
          embedding,
          matchCount,
          matchThreshold: fallbackThreshold,
        });
      }

      if (selectedMemories.length === 0) {
        return { memoryInjected: true };
      }

      const memoryBlock = formatMemoryBlock(selectedMemories);
      const enrichedPrompt = state.systemPrompt
        ? `${state.systemPrompt}\n\n${memoryBlock}`
        : memoryBlock;

      void bumpMemoryRetrievalStats(
        db,
        selectedMemories.map((memory) => memory.id)
      ).catch((error) => {
        console.error("Failed to bump memory retrieval stats", {
          userId: state.userId,
          memoryCount: selectedMemories.length,
          error,
        });
      });

      return {
        messages: [new SystemMessage(memoryBlock)],
        systemPrompt: enrichedPrompt,
        memoryInjected: true,
      };
    } catch (error) {
      console.error("Memory injection skipped due to error", {
        userId: state.userId,
        error,
      });
      return { memoryInjected: true };
    }
  };
}
