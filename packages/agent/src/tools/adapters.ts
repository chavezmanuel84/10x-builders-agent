import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(
  toolId: string,
  ctx: ToolContext
): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

function getOctokit(token?: string): Octokit {
  if (!token) throw new Error("GitHub token not available");
  return new Octokit({ auth: token });
}

/**
 * Executes a confirmed GitHub tool call. Shared between the graph tools
 * and the confirmation endpoints (web + Telegram) so the real API call
 * lives in one place.
 */
export async function executeGitHubTool(
  toolName: string,
  args: Record<string, unknown>,
  githubToken: string
): Promise<Record<string, unknown>> {
  const octokit = getOctokit(githubToken);

  switch (toolName) {
    case "github_create_issue": {
      const { data } = await octokit.issues.create({
        owner: args.owner as string,
        repo: args.repo as string,
        title: args.title as string,
        body: (args.body as string) || "",
      });
      return { issue_url: data.html_url, number: data.number, title: data.title };
    }
    case "github_create_repo": {
      const { data } = await octokit.repos.createForAuthenticatedUser({
        name: args.name as string,
        description: (args.description as string) || "",
        private: (args.private as boolean) ?? false,
      });
      return { repo_url: data.html_url, full_name: data.full_name };
    }
    default:
      throw new Error(`Unknown GitHub tool: ${toolName}`);
  }
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_repos", input, false
          );
          try {
            const octokit = getOctokit(ctx.githubToken);
            const { data } = await octokit.repos.listForAuthenticatedUser({
              per_page: input.per_page,
              sort: "updated",
            });
            const repos = data.map((r) => ({
              full_name: r.full_name,
              description: r.description,
              html_url: r.html_url,
              private: r.private,
            }));
            const result = { repos };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_issues", input, false
          );
          try {
            const octokit = getOctokit(ctx.githubToken);
            const { data } = await octokit.issues.listForRepo({
              owner: input.owner,
              repo: input.repo,
              state: input.state as "open" | "closed" | "all",
            });
            const issues = data.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              html_url: i.html_url,
            }));
            const result = { issues };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_issue", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              message: `Crear issue "${input.title}" en ${input.owner}/${input.repo}`,
            });
          }
          try {
            const result = await executeGitHubTool("github_create_issue", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_repo", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              message: `Crear repositorio "${input.name}"${input.private ? " (privado)" : ""}`,
            });
          }
          try {
            const result = await executeGitHubTool("github_create_repo", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            private: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  return tools;
}
