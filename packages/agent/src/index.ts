export { runAgent, resumeAgent, graphStateHasPendingInterrupt } from "./graph";
export type { ResumeAgentInput } from "./graph";
export { TOOL_CATALOG } from "./tools/catalog";
export {
  executeGitHubTool,
  executeGoogleCalendarTool,
  executeRiskyIntegrationTool,
} from "./tools/adapters";
export { resolvePendingContextReply } from "./pending-context-resolver";
export { getNextCronRunAt, assertValidTimezone } from "./scheduling";
export { validateWorkspaceRoot } from "./tools/bash-exec";
export { flushSessionMemories } from "./memory_flush";
export type { AgentInput, AgentOutput } from "./graph";
export type { ToolContext } from "./tools/adapters";
export type {
  PendingContextCandidate,
  PendingResolutionResult,
} from "./pending-context-resolver";

/**
 * Appends workspace root context to the user's system prompt so the LLM
 * always knows which directory it is operating in and never needs to guess,
 * and ensures the prompt has today's date in the user's timezone context.
 */
export function buildSystemPrompt(
  base: string,
  timezone: string = "America/Bogota"
): string {
  const now = new Date();
  let todayIso = "";
  try {
    const dateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = dateParts.find((p) => p.type === "year")?.value ?? "";
    const m = dateParts.find((p) => p.type === "month")?.value ?? "";
    const d = dateParts.find((p) => p.type === "day")?.value ?? "";
    todayIso = y && m && d ? `${y}-${m}-${d}` : "";
  } catch {
    todayIso = now.toISOString().slice(0, 10);
  }

  const baseWithDate = base.includes(todayIso)
    ? base
    : `${base}\n\nFecha actual (${timezone}): ${todayIso}`;

  const root = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (!root) return baseWithDate;
  return `${baseWithDate}\n\nWorkspace root: ${root}`;
}
