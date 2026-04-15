export { runAgent, resumeAgent, graphStateHasPendingInterrupt } from "./graph";
export type { ResumeAgentInput } from "./graph";
export { TOOL_CATALOG } from "./tools/catalog";
export {
  executeGitHubTool,
  executeGoogleCalendarTool,
  executeRiskyIntegrationTool,
} from "./tools/adapters";
export { resolvePendingContextReply } from "./pending-context-resolver";
export { validateWorkspaceRoot } from "./tools/bash-exec";
export type { AgentInput, AgentOutput } from "./graph";
export type { ToolContext } from "./tools/adapters";
export type {
  PendingContextCandidate,
  PendingResolutionResult,
} from "./pending-context-resolver";

/**
 * Appends workspace root context to the user's system prompt so the LLM
 * always knows which directory it is operating in and never needs to guess.
 * When AGENT_WORKSPACE_ROOT is not set the prompt is returned unchanged.
 */
export function buildSystemPrompt(base: string): string {
  const root = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (!root) return base;
  return `${base}\n\nWorkspace root: ${root}`;
}
