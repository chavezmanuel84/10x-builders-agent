import { StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type {
  ConversationContextPayload,
  PendingConfirmation,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  pendingConfirmation: Annotation<PendingConfirmation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleCalendarToken?: string;
  userTimezone: string;
  contextInstruction?: string;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function extractRepoName(message: string): string | null {
  const quoted = message.match(/["“]([^"”]+)["”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const named = message.match(/(?:llamado|named)\s+([a-z0-9._\-\s]+)/i);
  if (named?.[1]) return named[1].trim().replace(/[?.!,;:]+$/, "");
  return null;
}

function detectPendingInputPayload(
  userMessage: string,
  assistantMessage: string
): ConversationContextPayload | null {
  const assistantNorm = normalizeText(assistantMessage);
  const userNorm = normalizeText(userMessage);
  const asksVisibility =
    assistantNorm.includes("public") &&
    assistantNorm.includes("privad") &&
    assistantNorm.includes("repositorio");
  const isRepoCreationFlow =
    userNorm.includes("repo") &&
    (userNorm.includes("crea") || userNorm.includes("crear"));
  if (!asksVisibility || !isRepoCreationFlow) return null;

  return {
    context_type: "pending_input",
    context_status: "active",
    tool_name: "github_create_repo",
    pending_field: "visibility",
    entity: { repo_name: extractRepoName(userMessage) ?? "el repositorio" },
  };
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    googleCalendarToken,
    userTimezone,
    contextInstruction,
  } = input;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
    googleCalendarToken,
    userTimezone,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];
    let confirmation: PendingConfirmation | null = null;

    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const resultStr = String(result);
        results.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id! }));

        try {
          const parsed = JSON.parse(resultStr);
          if (parsed.pending_confirmation) {
            confirmation = {
              toolCallId: parsed.tool_call_id,
              toolName: tc.name,
              message: parsed.message,
              args: tc.args,
            };
          }
        } catch {
          // not JSON — regular tool result
        }
      }
    }

    return {
      messages: results,
      ...(confirmation ? { pendingConfirmation: confirmation } : {}),
    };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    if (state.pendingConfirmation) return "end";

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "agent");

  const checkpointer = new MemorySaver();
  const app = graph.compile({ checkpointer });

  const initialMessages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...(contextInstruction ? [new SystemMessage(contextInstruction)] : []),
    ...priorMessages,
    new HumanMessage(message),
  ];

  const finalState = await app.invoke(
    { messages: initialMessages, sessionId, userId, systemPrompt, pendingConfirmation: null },
    { configurable: { thread_id: sessionId } }
  );

  const pendingConfirmation: PendingConfirmation | null = finalState.pendingConfirmation ?? null;

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  const structuredPayload: ConversationContextPayload | undefined = pendingConfirmation
    ? {
        context_type: "pending_confirmation",
        context_status: "active",
        tool_name: pendingConfirmation.toolName,
        pending_field: "confirmation",
        tool_call_id: pendingConfirmation.toolCallId,
        entity: pendingConfirmation.args,
      }
    : detectPendingInputPayload(message, responseText) ?? undefined;

  await addMessage(db, sessionId, "assistant", responseText, {
    ...(pendingConfirmation ? { tool_call_id: pendingConfirmation.toolCallId } : {}),
    ...(structuredPayload ? { structured_payload: structuredPayload } : {}),
  });

  return { response: responseText, toolCalls: toolCallNames, pendingConfirmation };
}
