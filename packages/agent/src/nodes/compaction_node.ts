import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

const TOOL_RESULT_CLEARED = "[tool result cleared]";
const LLM_COMPACTION_THRESHOLD = 0.8;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 120_000;
const DEFAULT_RECENT_TOOL_RESULTS_TO_KEEP = 5;
const DEFAULT_RECENT_TAIL_MESSAGES_TO_KEEP = 16;
const COMPACTION_FAILURE_LIMIT = 3;

interface CompactionState {
  messages: BaseMessage[];
  compactionCount?: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function messageRole(message: BaseMessage): string {
  if (message instanceof HumanMessage) return "human";
  if (message instanceof AIMessage) return "assistant";
  if (message instanceof ToolMessage) return "tool";
  if (message instanceof SystemMessage) return "system";
  return message.getType();
}

function normalizeContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function estimateTokenUsage(messages: BaseMessage[]): number {
  // Heuristic estimate: 1 token ~= 4 chars + fixed envelope per message.
  return messages.reduce((sum, msg) => sum + Math.ceil(normalizeContent(msg.content).length / 4) + 12, 0);
}

function stripAnalysisBlocks(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

function microCompactMessages(
  messages: BaseMessage[],
  keepRecentToolResults: number
): { changed: boolean; messages: BaseMessage[] } {
  const toolIndexes = messages.reduce<number[]>((acc, msg, index) => {
    if (msg instanceof ToolMessage) acc.push(index);
    return acc;
  }, []);

  if (toolIndexes.length <= keepRecentToolResults) {
    return { changed: false, messages };
  }

  const keepIndexes = new Set(toolIndexes.slice(-keepRecentToolResults));
  let changed = false;

  const nextMessages = messages.map((msg, index) => {
    if (!(msg instanceof ToolMessage)) return msg;
    if (keepIndexes.has(index)) return msg;
    if (normalizeContent(msg.content) === TOOL_RESULT_CLEARED) return msg;

    changed = true;
    return new ToolMessage({
      content: TOOL_RESULT_CLEARED,
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      additional_kwargs: msg.additional_kwargs,
      response_metadata: msg.response_metadata,
      id: msg.id,
    });
  });

  return { changed, messages: nextMessages };
}

function buildCompactionPrompt(messages: BaseMessage[]): string {
  const rendered = messages
    .map((msg, idx) => {
      const body = normalizeContent(msg.content);
      return `[#${idx}] role=${messageRole(msg)}\n${body}`;
    })
    .join("\n\n");

  return [
    "Compact the conversation into EXACTLY these 9 sections with concise bullet points:",
    "1) Session objective",
    "2) Stable user preferences and constraints",
    "3) Confirmed facts and environment",
    "4) Work completed so far",
    "5) Open tasks and blockers",
    "6) Tool outputs still relevant",
    "7) Pending confirmations and approvals",
    "8) Risks and edge cases to watch",
    "9) Next best actions",
    "",
    "Rules:",
    "- Preserve critical technical details and user intent.",
    "- Keep chronology when relevant.",
    "- Do not invent facts.",
    "- Return plain text only.",
    "",
    "Conversation to compact:",
    rendered,
  ].join("\n");
}

function createCompactionModel(): ChatOpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: process.env.COMPACTION_MODEL ?? "anthropic/claude-3.5-haiku",
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

export function createCompactionNode() {
  const model = createCompactionModel();
  const contextWindowTokens = parsePositiveInt(
    process.env.COMPACTION_CONTEXT_WINDOW_TOKENS,
    DEFAULT_CONTEXT_WINDOW_TOKENS
  );
  const keepRecentToolResults = parsePositiveInt(
    process.env.COMPACTION_KEEP_RECENT_TOOL_RESULTS,
    DEFAULT_RECENT_TOOL_RESULTS_TO_KEEP
  );
  const keepRecentTailMessages = parsePositiveInt(
    process.env.COMPACTION_RECENT_TAIL_MESSAGES,
    DEFAULT_RECENT_TAIL_MESSAGES_TO_KEEP
  );

  return async function compactionNode(
    state: CompactionState
  ): Promise<Partial<CompactionState>> {
    const failureCount = state.compactionCount ?? 0;
    if (failureCount >= COMPACTION_FAILURE_LIMIT) {
      // Circuit breaker: bypass compaction after repeated failures.
      return {};
    }

    const originalMessages = state.messages ?? [];
    if (originalMessages.length === 0) return {};

    const micro = microCompactMessages(originalMessages, keepRecentToolResults);
    const candidateMessages = micro.messages;
    const usageRatio = estimateTokenUsage(candidateMessages) / contextWindowTokens;

    if (usageRatio <= LLM_COMPACTION_THRESHOLD) {
      return micro.changed ? { messages: candidateMessages } : {};
    }

    // Keep leading system messages and the recent tail as-is.
    const leadingSystemCount = candidateMessages.findIndex((m) => !(m instanceof SystemMessage));
    const systemsEnd = leadingSystemCount === -1 ? candidateMessages.length : leadingSystemCount;
    const tailStart = Math.max(systemsEnd, candidateMessages.length - keepRecentTailMessages);
    const segmentToCompact = candidateMessages.slice(systemsEnd, tailStart);

    if (segmentToCompact.length === 0) {
      return micro.changed ? { messages: candidateMessages } : {};
    }

    try {
      const prompt = buildCompactionPrompt(segmentToCompact);
      const llmOutput = await model.invoke([new HumanMessage(prompt)]);
      const cleaned = stripAnalysisBlocks(normalizeContent(llmOutput.content));
      if (!cleaned) {
        throw new Error("Compaction model returned empty content");
      }

      const summaryMessage = new SystemMessage({
        content: `[compaction summary]\n${cleaned}`,
      });
      const compactedMessages = [
        ...candidateMessages.slice(0, systemsEnd),
        summaryMessage,
        ...candidateMessages.slice(tailStart),
      ];
      return { messages: compactedMessages, compactionCount: 0 };
    } catch {
      const nextFailureCount = failureCount + 1;
      if (nextFailureCount >= COMPACTION_FAILURE_LIMIT) {
        // Third consecutive failure: passthrough to avoid retry loops.
        return { compactionCount: nextFailureCount };
      }
      return {
        ...(micro.changed ? { messages: candidateMessages } : {}),
        compactionCount: nextFailureCount,
      };
    }
  };
}
