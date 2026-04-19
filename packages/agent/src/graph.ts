import {
  StateGraph,
  Annotation,
  interrupt,
  Command,
  type StateSnapshot,
} from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { DbClient } from "@agents/db";
import type {
  ConversationContextPayload,
  HitlResumeDecision,
  PendingConfirmation,
  UserIntegration,
  UserToolSetting,
  DeferHitlToolResult,
} from "@agents/types";
import { createChatModel } from "./model";
import {
  buildLangChainTools,
  buildHitlInterruptSummary,
  executeApprovedSideEffect,
  type ToolContext,
} from "./tools/adapters";
import {
  getSessionMessages,
  addMessage,
  createToolCall,
  updateToolCallStatus,
  closeActiveContextsByToolCallId,
  getExistingPendingToolCallForSession,
} from "@agents/db";
import { getLangGraphCheckpointer } from "./checkpointer";
import { toolRequiresConfirmation } from "./tools/catalog";
import { createCompactionNode } from "./nodes/compaction_node";
import { createMemoryInjectionNode } from "./nodes/memory_injection_node";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  // Tracks the agent's working directory for the duration of the session.
  // The default is AGENT_WORKSPACE_ROOT (or process.cwd() if unset).
  // Updated by change_directory tool calls; persisted across turns via checkpoint.
  currentDirectory: Annotation<string>({
    default: () => process.env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd(),
    // Safe reducer: only overwrite when a non-empty value is emitted.
    // Old checkpoints without this field produce undefined → keep prev.
    reducer: (prev, next) =>
      next !== undefined && next !== null && next !== "" ? next : prev,
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  compactionCount: Annotation<number>({
    default: () => 0,
    // Old checkpoints won't have this field; keep previous value when absent.
    reducer: (prev, next) => (next !== undefined && next !== null ? next : prev),
  }),
  memoryInjected: Annotation<boolean>({
    default: () => false,
    reducer: (prev, next) => (next !== undefined && next !== null ? next : prev),
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

export interface ResumeAgentInput {
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleCalendarToken?: string;
  userTimezone: string;
  decision: HitlResumeDecision;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
  /** Set when resume was rejected because the thread is not awaiting HITL. */
  error?: string;
}

const MAX_TOOL_ITERATIONS = 6;

/** LangGraph interrupt channel key (same as `INTERRUPT` in @langchain/langgraph/constants). */
const INTERRUPT_CHANNEL = "__interrupt__";

const HITL_KIND = "hitl_tool" as const;

interface HitlInterruptValue {
  kind: typeof HITL_KIND;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
  auditToolCallId: string;
}

export function graphStateHasPendingInterrupt(snapshot: StateSnapshot): boolean {
  return snapshot.tasks.some(
    (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0
  );
}

function extractAuditIdFromInterruptSnapshot(snapshot: StateSnapshot): string | null {
  for (const t of snapshot.tasks) {
    for (const intr of t.interrupts ?? []) {
      const v = (intr as { value?: unknown }).value as HitlInterruptValue | undefined;
      if (v?.kind === HITL_KIND && v.auditToolCallId) return v.auditToolCallId;
    }
  }
  return null;
}

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

function isDeferHitlPayload(parsed: unknown): parsed is DeferHitlToolResult {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as DeferHitlToolResult).defer_hitl === true &&
    typeof (parsed as DeferHitlToolResult).summary === "string"
  );
}

function extractHitlInterruptFromInvokeResult(
  state: Record<string, unknown>
): HitlInterruptValue | null {
  const raw = state[INTERRUPT_CHANNEL];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0] as { value?: unknown };
  const v = first?.value;
  if (
    typeof v === "object" &&
    v !== null &&
    (v as HitlInterruptValue).kind === HITL_KIND
  ) {
    return v as HitlInterruptValue;
  }
  return null;
}

function extractHitlFromStateSnapshot(snapshot: StateSnapshot): HitlInterruptValue | null {
  for (const t of snapshot.tasks) {
    for (const intr of t.interrupts ?? []) {
      const v = (intr as { value?: unknown }).value;
      if (
        typeof v === "object" &&
        v !== null &&
        (v as HitlInterruptValue).kind === HITL_KIND
      ) {
        return v as HitlInterruptValue;
      }
    }
  }
  return null;
}

function hitlToPendingConfirmation(v: HitlInterruptValue): PendingConfirmation {
  return {
    toolCallId: v.auditToolCallId,
    toolName: v.toolName,
    message: v.summary,
    args: v.args,
  };
}

function buildToolContext(
  input: Omit<AgentInput, "message" | "contextInstruction">,
  currentDirectory?: string
): ToolContext {
  return {
    db: input.db,
    userId: input.userId,
    sessionId: input.sessionId,
    enabledTools: input.enabledTools,
    integrations: input.integrations,
    githubToken: input.githubToken,
    googleCalendarToken: input.googleCalendarToken,
    userTimezone: input.userTimezone,
    currentDirectory:
      currentDirectory ?? process.env.AGENT_WORKSPACE_ROOT?.trim() ?? process.cwd(),
  };
}

async function compileAgentGraph(
  toolCtx: ToolContext,
  _systemPrompt: string,
  checkpointer: Awaited<ReturnType<typeof getLangGraphCheckpointer>>
) {
  const model = createChatModel();
  const lcTools = buildLangChainTools(toolCtx);
  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;
  const compactionNode = createCompactionNode();
  const memoryInjectionNode = createMemoryInjectionNode(toolCtx.db);
  const toolCallNamesRef = { names: [] as string[] };

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

    const results: BaseMessage[] = [];
    const { db, sessionId } = toolCtx;

    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNamesRef.names.push(tc.name);
      if (!matchingTool || !tc.id) continue;
      const toolCallId = tc.id;

      const requiresConf = toolRequiresConfirmation(tc.name);

      async function runHitlInterruptFlow(summary: string): Promise<void> {
        // LangGraph re-runs this node from the beginning on resume, which would call
        // createToolCall again and produce a duplicate pending_confirmation row. Reuse
        // the existing pending record for this session+tool if one already exists.
        const existing = await getExistingPendingToolCallForSession(db, sessionId, tc.name);
        const record = existing ?? await createToolCall(
          db,
          sessionId,
          tc.name,
          tc.args as Record<string, unknown>,
          true
        );
        const interruptPayload: HitlInterruptValue = {
          kind: HITL_KIND,
          toolName: tc.name,
          args: tc.args as Record<string, unknown>,
          summary,
          auditToolCallId: record.id,
        };

        const decision = interrupt(interruptPayload) as HitlResumeDecision;

        if (decision.decision === "reject") {
          await updateToolCallStatus(
            db,
            record.id,
            "rejected",
            { message: decision.message },
            sessionId
          );
          results.push(
            new ToolMessage({
              content: JSON.stringify({
                rejected: true,
                message: decision.message,
              }),
              tool_call_id: toolCallId,
            })
          );
          return;
        }

        try {
          const execResult = await executeApprovedSideEffect(
            tc.name,
            tc.args as Record<string, unknown>,
            toolCtx
          );
          await updateToolCallStatus(db, record.id, "executed", execResult, sessionId);
          results.push(
            new ToolMessage({
              content: JSON.stringify(execResult),
              tool_call_id: toolCallId,
            })
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Execution failed";
          await updateToolCallStatus(
            db,
            record.id,
            "failed",
            { error: message },
            sessionId
          );
          results.push(
            new ToolMessage({
              content: JSON.stringify({ error: message }),
              tool_call_id: toolCallId,
            })
          );
        }
      }

      if (requiresConf) {
        const summary = buildHitlInterruptSummary(
          tc.name,
          tc.args as Record<string, unknown>
        );
        await runHitlInterruptFlow(summary);
        continue;
      }

      const resultStr = await (matchingTool as DynamicStructuredTool).invoke(tc.args);
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(resultStr));
      } catch {
        results.push(new ToolMessage({ content: String(resultStr), tool_call_id: toolCallId }));
        continue;
      }

      if (isDeferHitlPayload(parsed)) {
        await runHitlInterruptFlow(parsed.summary);
      } else {
        results.push(new ToolMessage({ content: String(resultStr), tool_call_id: toolCallId }));
      }
    }

    // Always emit currentDirectory so the checkpoint stays in sync with any
    // mutation that change_directory made to toolCtx.currentDirectory.
    return { messages: results, currentDirectory: toolCtx.currentDirectory };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      // Count only AIMessages with tool_calls that appear after the last
      // HumanMessage so the limit applies per agent turn, not per session.
      // Without this, the global counter hits MAX_TOOL_ITERATIONS across the
      // entire checkpointed session and permanently blocks all tool use.
      const lastHumanIdx = [...state.messages]
        .reverse()
        .findIndex((m) => m instanceof HumanMessage);
      const messagesThisTurn =
        lastHumanIdx >= 0
          ? state.messages.slice(state.messages.length - lastHumanIdx)
          : state.messages;
      const iterations = messagesThisTurn.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "memory_injection")
    .addEdge("memory_injection", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checkpoint-saver typings conflict across nested @langchain/langgraph-checkpoint copies
  const app = graph.compile({ checkpointer: checkpointer as any });
  return { app, lcTools, toolCallNamesRef };
}

function lastAiText(state: typeof GraphState.State): string {
  const lastMessage = state.messages[state.messages.length - 1];
  return typeof lastMessage.content === "string"
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);
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

  const checkpointer = await getLangGraphCheckpointer();
  // Build toolCtx with the default currentDirectory first — compileAgentGraph
  // needs it before the snapshot is available. The snapshot is read next and
  // the persisted currentDirectory is applied via mutation so all closed-over
  // tool implementations see the correct session value before invoke.
  const toolCtx = buildToolContext({
    db,
    userId,
    sessionId,
    systemPrompt,
    enabledTools,
    integrations,
    githubToken,
    googleCalendarToken,
    userTimezone,
  });

  const { app, toolCallNamesRef } = await compileAgentGraph(
    toolCtx,
    systemPrompt,
    checkpointer
  );

  const config = { configurable: { thread_id: sessionId } };
  const snapshot = await app.getState(config);

  // Restore session-level currentDirectory from the checkpoint so the agent
  // continues from where it last was (e.g. after a change_directory call).
  const savedDirectory = (snapshot.values as Partial<typeof GraphState.State>)?.currentDirectory;
  if (savedDirectory) toolCtx.currentDirectory = savedDirectory;

  // Guard: if a HITL interrupt is already pending, do not invoke the graph.
  // Calling app.invoke with new input on a paused thread replays toolExecutorNode
  // from the start, creating a duplicate tool_calls row and desynchronising the
  // auditToolCallId stored in the checkpoint from the one shown in the UI.
  if (graphStateHasPendingInterrupt(snapshot)) {
    const hitl = extractHitlFromStateSnapshot(snapshot);
    const pendingConfirmation = hitl ? hitlToPendingConfirmation(hitl) : null;
    await addMessage(db, sessionId, "user", message);
    return {
      response: pendingConfirmation?.message ?? "",
      toolCalls: [],
      pendingConfirmation,
      error: "pending_hitl",
    };
  }

  const existing = (snapshot.values?.messages ?? []) as BaseMessage[];

  let graphInput: Partial<typeof GraphState.State>;

  if (existing.length === 0) {
    const history = await getSessionMessages(db, sessionId, 30);
    const priorMessages: BaseMessage[] = history.map((m) => {
      if (m.role === "user") return new HumanMessage(m.content);
      if (m.role === "assistant") return new AIMessage(m.content);
      return new HumanMessage(m.content);
    });
    graphInput = {
      messages: [
        new SystemMessage(systemPrompt),
        ...(contextInstruction ? [new SystemMessage(contextInstruction)] : []),
        ...priorMessages,
        new HumanMessage(message),
      ],
      sessionId,
      userId,
      systemPrompt,
      memoryInjected: false,
    };
  } else {
    graphInput = {
      messages: [
        ...(contextInstruction ? [new SystemMessage(contextInstruction)] : []),
        new HumanMessage(message),
      ],
      sessionId,
      userId,
      systemPrompt,
      memoryInjected: false,
    };
  }

  await addMessage(db, sessionId, "user", message);

  const finalState = (await app.invoke(graphInput, config)) as typeof GraphState.State &
    Record<string, unknown>;

  toolCallNamesRef.names = [...new Set(toolCallNamesRef.names)];

  let hitl = extractHitlInterruptFromInvokeResult(finalState as Record<string, unknown>);
  if (!hitl) {
    const postSnap = await app.getState(config);
    if (graphStateHasPendingInterrupt(postSnap)) {
      hitl = extractHitlFromStateSnapshot(postSnap);
    }
  }
  const pendingConfirmation = hitl ? hitlToPendingConfirmation(hitl) : null;

  const responseText = pendingConfirmation
    ? pendingConfirmation.message
    : lastAiText(finalState);
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

  return {
    response: responseText,
    toolCalls: toolCallNamesRef.names,
    pendingConfirmation,
  };
}

export async function resumeAgent(input: ResumeAgentInput): Promise<AgentOutput> {
  const {
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    googleCalendarToken,
    userTimezone,
    decision,
  } = input;

  const checkpointer = await getLangGraphCheckpointer();
  const toolCtx = buildToolContext({
    db,
    userId,
    sessionId,
    systemPrompt,
    enabledTools,
    integrations,
    githubToken,
    googleCalendarToken,
    userTimezone,
  });

  const { app, toolCallNamesRef } = await compileAgentGraph(
    toolCtx,
    systemPrompt,
    checkpointer
  );

  const config = { configurable: { thread_id: sessionId } };
  const snapshot = await app.getState(config);

  // Restore session-level currentDirectory from the checkpoint so resumed
  // executions continue from the directory set before the HITL pause.
  const savedDirectory = (snapshot.values as Partial<typeof GraphState.State>)?.currentDirectory;
  if (savedDirectory) toolCtx.currentDirectory = savedDirectory;

  if (!graphStateHasPendingInterrupt(snapshot)) {
    return {
      response: "",
      toolCalls: [],
      pendingConfirmation: null,
      error:
        "No hay una acción pendiente de confirmación para esta conversación. Actualiza la página o envía un mensaje nuevo.",
    };
  }

  const auditIdBeforeResume = extractAuditIdFromInterruptSnapshot(snapshot);

  const finalState = (await app.invoke(new Command({ resume: decision }), config)) as typeof GraphState.State &
    Record<string, unknown>;

  let hitl = extractHitlInterruptFromInvokeResult(finalState as Record<string, unknown>);
  if (!hitl) {
    const postSnap = await app.getState(config);
    if (graphStateHasPendingInterrupt(postSnap)) {
      hitl = extractHitlFromStateSnapshot(postSnap);
    }
  }
  const pendingConfirmation = hitl ? hitlToPendingConfirmation(hitl) : null;
  const responseText = pendingConfirmation
    ? pendingConfirmation.message
    : lastAiText(finalState);

  if (decision.decision === "reject" && auditIdBeforeResume) {
    await closeActiveContextsByToolCallId(
      db,
      sessionId,
      auditIdBeforeResume,
      "rejected"
    );
  } else if (decision.decision === "approve" && auditIdBeforeResume) {
    // Always close the approved context row regardless of whether a new interrupt
    // followed immediately. The next interrupt creates its own agent_messages row;
    // leaving the previous one open produces orphaned "active" pending_confirmation
    // rows that accumulate in the DB across chained approvals.
    await closeActiveContextsByToolCallId(
      db,
      sessionId,
      auditIdBeforeResume,
      "executed"
    );
  }

  const structuredPayload: ConversationContextPayload | undefined = pendingConfirmation
    ? {
        context_type: "pending_confirmation",
        context_status: "active",
        tool_name: pendingConfirmation.toolName,
        pending_field: "confirmation",
        tool_call_id: pendingConfirmation.toolCallId,
        entity: pendingConfirmation.args,
      }
    : undefined;

  await addMessage(db, sessionId, "assistant", responseText, {
    ...(pendingConfirmation ? { tool_call_id: pendingConfirmation.toolCallId } : {}),
    ...(structuredPayload ? { structured_payload: structuredPayload } : {}),
  });

  return {
    response: responseText,
    toolCalls: toolCallNamesRef.names,
    pendingConfirmation,
  };
}
