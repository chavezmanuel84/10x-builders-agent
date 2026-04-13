import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { google } from "googleapis";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration, DeferHitlToolResult } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { runBashCommandOnce } from "./bash-exec";
import { readFileContents, writeFileContents, editFileContents } from "./file-ops";
import { createToolCall, updateToolCallStatus } from "@agents/db";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  googleCalendarToken?: string;
  userTimezone: string;
}

function todayDateStr(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

/** Returns the UTC offset string (e.g. "-05:00", "+05:30") for a given IANA timezone. */
function tzOffsetStr(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (!tzPart) return "+00:00";
    const m = tzPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return "+00:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${m[3] || "00"}`;
  } catch {
    return "+00:00";
  }
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
    case "github_list_repos": {
      const { data } = await octokit.repos.listForAuthenticatedUser({
        per_page: (args.per_page as number) ?? 10,
        sort: "updated",
      });
      const repos = data.map((r) => ({
        full_name: r.full_name,
        description: r.description,
        html_url: r.html_url,
        private: r.private,
      }));
      return { repos };
    }
    case "github_list_issues": {
      const { data } = await octokit.issues.listForRepo({
        owner: args.owner as string,
        repo: args.repo as string,
        state: (args.state as "open" | "closed" | "all") ?? "open",
      });
      const issues = data.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        html_url: i.html_url,
      }));
      return { issues };
    }
    default:
      throw new Error(`Unknown GitHub tool: ${toolName}`);
  }
}

function getGoogleCalendarClient(tokenJson: string) {
  const tokens = JSON.parse(tokenJson);
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });
  return google.calendar({ version: "v3", auth: oauth2Client });
}

/**
 * Runs a side-effecting GitHub or Google Calendar tool after HITL approval (graph tools node).
 */
/** User-facing summary when pausing for HITL (aligned with catalog / former defer_hitl copy). */
export function buildHitlInterruptSummary(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "github_create_issue":
      return `Crear issue "${args.title}" en ${args.owner}/${args.repo}`;
    case "github_create_repo":
      return `Crear repositorio "${args.name}"${args.private ? " (privado)" : ""}`;
    case "gcal_create_event": {
      const attendees = (args.attendees as string[] | undefined)?.length
        ? ` con ${(args.attendees as string[]).join(", ")}`
        : "";
      return `Crear evento "${args.title}" (${args.start} → ${args.end})${attendees}`;
    }
    case "write_file": {
      const bytesEstimate = Buffer.byteLength(
        typeof args.content === "string" ? args.content : "",
        "utf8"
      );
      return `Crear archivo nuevo: ${args.path} (${bytesEstimate} bytes)`;
    }
    case "edit_file": {
      const MAX = 120;
      const truncate = (s: string) =>
        s.length > MAX ? `${s.slice(0, MAX)}…` : s;
      const oldPreview = truncate(typeof args.old_string === "string" ? args.old_string : "");
      const newPreview = truncate(typeof args.new_string === "string" ? args.new_string : "");
      return `Editar ${args.path} — reemplazar:\n  « ${oldPreview} »\n  → « ${newPreview} »`;
    }
    case "get_user_preferences":
      return "Leer preferencias y configuración del usuario";
    case "bash": {
      const raw = typeof args.prompt === "string" ? args.prompt : "";
      const line = raw.trim().replace(/\s+/g, " ");
      const max = 160;
      const cmdPreview = line.length > max ? `${line.slice(0, max)}…` : line;
      const cwdPart =
        typeof args.cwd === "string" && args.cwd.trim()
          ? ` (cwd: ${args.cwd})`
          : "";
      const termPart =
        typeof args.terminal === "string" && args.terminal.trim()
          ? ` [${args.terminal}]`
          : "";
      return `Ejecutar bash: ${cmdPreview || "(vacío)"}${cwdPart}${termPart}`;
    }
    default: {
      const def = TOOL_CATALOG.find((t) => t.name === toolName);
      return def?.description ?? `Ejecutar: ${toolName}`;
    }
  }
}

/**
 * Runs the real side effect after HITL approval (graph tools node).
 * Does not insert tool_calls rows; caller owns audit `record` updates.
 */
export async function executeApprovedSideEffect(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  if (toolName === "get_user_preferences") {
    const { getProfile } = await import("@agents/db");
    const profile = await getProfile(ctx.db, ctx.userId);
    return {
      name: profile.name,
      timezone: profile.timezone,
      language: profile.language,
      agent_name: profile.agent_name,
    };
  }
  if (toolName === "list_enabled_tools") {
    const enabled = ctx.enabledTools.filter((t) => t.enabled).map((t) => t.tool_id);
    return { tool_ids: enabled };
  }

  if (toolName === "write_file") {
    const filePath = args.path;
    const content = args.content;
    if (typeof filePath !== "string") {
      throw new Error("write_file: path must be a string");
    }
    if (typeof content !== "string") {
      throw new Error("write_file: content must be a string");
    }
    const result = await writeFileContents(filePath, content);
    return { ...result } as Record<string, unknown>;
  }

  if (toolName === "edit_file") {
    const filePath = args.path;
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof filePath !== "string") {
      throw new Error("edit_file: path must be a string");
    }
    if (typeof oldString !== "string") {
      throw new Error("edit_file: old_string must be a string");
    }
    if (typeof newString !== "string") {
      throw new Error("edit_file: new_string must be a string");
    }
    const result = await editFileContents(filePath, oldString, newString);
    return { ...result } as Record<string, unknown>;
  }

  if (toolName.startsWith("gcal_")) {
    return executeGoogleCalendarTool(
      toolName,
      args,
      ctx.googleCalendarToken!,
      ctx.userTimezone
    );
  }
  if (toolName.startsWith("github_")) {
    return executeGitHubTool(toolName, args, ctx.githubToken!);
  }

  if (toolName === "bash") {
    if (process.env.BASH_TOOL_ENABLED !== "true") {
      throw new Error(
        "Bash tool is disabled. Set BASH_TOOL_ENABLED=true on the server to allow execution after approval."
      );
    }
    const prompt = args.prompt;
    if (typeof prompt !== "string") {
      throw new Error("bash tool: prompt must be a string");
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const terminal = typeof args.terminal === "string" ? args.terminal : undefined;
    const result = await runBashCommandOnce({ prompt, cwd, terminal });
    return { ...result } as Record<string, unknown>;
  }

  throw new Error(`HITL execution not implemented for tool: ${toolName}`);
}

export async function executeRiskyIntegrationTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  if (toolName.startsWith("github_")) {
    return executeGitHubTool(toolName, args, ctx.githubToken!);
  }
  if (toolName.startsWith("gcal_")) {
    return executeGoogleCalendarTool(
      toolName,
      args,
      ctx.googleCalendarToken!,
      ctx.userTimezone
    );
  }
  throw new Error(`Unknown integration tool: ${toolName}`);
}

export async function executeGoogleCalendarTool(
  toolName: string,
  args: Record<string, unknown>,
  googleCalendarToken: string,
  userTimezone: string = "UTC"
): Promise<Record<string, unknown>> {
  const tz = userTimezone || "UTC";
  const calendar = getGoogleCalendarClient(googleCalendarToken);

  switch (toolName) {
    case "gcal_list_events": {
      const dateStr = (args.date as string) || todayDateStr(tz);
      const offset = tzOffsetStr(tz);
      const timeMin = `${dateStr}T00:00:00${offset}`;
      const timeMax = `${dateStr}T23:59:59${offset}`;
      console.log(`[gcal] ${toolName}`, { dateStr, tz, offset, timeMin, timeMax });
      const { data } = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        timeZone: tz,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25,
      });
      const events = (data.items ?? []).map((e) => ({
        title: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        htmlLink: e.htmlLink,
        meetLink: e.hangoutLink ?? null,
      }));
      return { events, date: dateStr };
    }
    case "gcal_query_events": {
      const startDate = args.start_date as string;
      const endDate = args.end_date as string;
      const offset = tzOffsetStr(tz);
      const timeMin = `${startDate}T00:00:00${offset}`;
      const timeMax = `${endDate}T23:59:59${offset}`;
      console.log(`[gcal] ${toolName}`, { startDate, endDate, tz, offset, timeMin, timeMax });
      const { data } = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        timeMax,
        timeZone: tz,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      const events = (data.items ?? []).map((e) => ({
        title: e.summary,
        start: e.start?.dateTime ?? e.start?.date,
        end: e.end?.dateTime ?? e.end?.date,
        htmlLink: e.htmlLink,
        meetLink: e.hangoutLink ?? null,
      }));
      return { events, start_date: startDate, end_date: endDate };
    }
    case "gcal_create_event": {
      const attendees = (args.attendees as string[] | undefined)?.map(
        (email) => ({ email })
      );
      console.log(`[gcal] ${toolName}`, { args, tz });
      const { data } = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: args.title as string,
          description: (args.description as string) || undefined,
          start: { dateTime: args.start as string, timeZone: tz },
          end: { dateTime: args.end as string, timeZone: tz },
          attendees,
        },
      });
      return {
        title: data.summary,
        start: data.start?.dateTime ?? data.start?.date,
        end: data.end?.dateTime ?? data.end?.date,
        htmlLink: data.htmlLink,
        meetLink: data.hangoutLink ?? null,
      };
    }
    default:
      throw new Error(`Unknown Google Calendar tool: ${toolName}`);
  }
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "get_user_preferences", {}, false
          );
          try {
            const { getProfile } = await import("@agents/db");
            const profile = await getProfile(ctx.db, ctx.userId);
            const result = {
              name: profile.name,
              timezone: profile.timezone,
              language: profile.language,
              agent_name: profile.agent_name,
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
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
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "list_enabled_tools", {}, false
          );
          try {
            const enabled = ctx.enabledTools
              .filter((t) => t.enabled)
              .map((t) => t.tool_id);
            await updateToolCallStatus(ctx.db, record.id, "executed", {
              tool_ids: enabled,
            });
            return JSON.stringify(enabled);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
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
          const payload: DeferHitlToolResult = {
            defer_hitl: true,
            summary: `Crear issue "${input.title}" en ${input.owner}/${input.repo}`,
            args: input as Record<string, unknown>,
          };
          return JSON.stringify(payload);
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
          const payload: DeferHitlToolResult = {
            defer_hitl: true,
            summary: `Crear repositorio "${input.name}"${input.private ? " (privado)" : ""}`,
            args: input as Record<string, unknown>,
          };
          return JSON.stringify(payload);
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

  // --- Google Calendar tools ---

  if (isToolAvailable("gcal_list_events", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "gcal_list_events", input, false
          );
          try {
            const result = await executeGoogleCalendarTool(
              "gcal_list_events", input, ctx.googleCalendarToken!, ctx.userTimezone
            );
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            console.error("[gcal] gcal_list_events failed:", err);
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "gcal_list_events",
          description:
            `Lists the user's upcoming Google Calendar events for a given day. Today is ${todayDateStr(ctx.userTimezone)}. Defaults to today if no date is provided.`,
          schema: z.object({
            date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
          }),
        }
      )
    );
  }

  if (isToolAvailable("gcal_query_events", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "gcal_query_events", input, false
          );
          try {
            const result = await executeGoogleCalendarTool(
              "gcal_query_events", input, ctx.googleCalendarToken!, ctx.userTimezone
            );
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            console.error("[gcal] gcal_query_events failed:", err);
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "gcal_query_events",
          description: "Queries Google Calendar events within a date range.",
          schema: z.object({
            start_date: z.string().describe("Start date (YYYY-MM-DD)"),
            end_date: z.string().describe("End date (YYYY-MM-DD)"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("gcal_create_event", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const attendeeInfo = input.attendees?.length
            ? ` con ${input.attendees.join(", ")}`
            : "";
          const payload: DeferHitlToolResult = {
            defer_hitl: true,
            summary: `Crear evento "${input.title}" (${input.start} → ${input.end})${attendeeInfo}`,
            args: input as Record<string, unknown>,
          };
          return JSON.stringify(payload);
        },
        {
          name: "gcal_create_event",
          description:
            "Creates a new event on the user's Google Calendar. Requires confirmation. Attendees must be specified by email address.",
          schema: z.object({
            title: z.string(),
            start: z.string().describe("Start datetime (ISO 8601)"),
            end: z.string().describe("End datetime (ISO 8601)"),
            description: z.string().optional().default(""),
            attendees: z.array(z.string()).optional().describe("List of attendee email addresses"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("read_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "read_file", input, false
          );
          try {
            const result = await readFileContents(input.path, input.offset, input.limit);
            await updateToolCallStatus(ctx.db, record.id, "executed", { ...result });
            return JSON.stringify(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", { error: message });
            return JSON.stringify({ error: message });
          }
        },
        {
          name: "read_file",
          description:
            "Use this tool to read the exact, literal content of a file on disk — including source code, config files, or any text file. " +
            "Do NOT use bash just to read a file (e.g. cat, head); use read_file instead. " +
            "Use bash only when you need shell features such as piping, globbing, or command substitution. " +
            "Supports optional offset (1-indexed line number to start from) and limit (max lines to return) for large files; omit both to read the whole file. " +
            "Call this tool before any write or edit operation to verify the current state of the file.",
          schema: z.object({
            path: z.string().describe("Absolute or relative path to the file to read"),
            offset: z.number().optional().describe("1-indexed line number to start reading from (optional)"),
            limit: z.number().optional().describe("Maximum number of lines to return (optional)"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("write_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const payload: DeferHitlToolResult = {
            defer_hitl: true,
            summary: buildHitlInterruptSummary("write_file", input as Record<string, unknown>),
            args: input as Record<string, unknown>,
          };
          return JSON.stringify(payload);
        },
        {
          name: "write_file",
          description:
            "Use this tool to create a brand-new file with the given content. " +
            "This tool is ONLY for files that do not yet exist on disk — it will refuse to overwrite an existing file. " +
            "To update an existing file use edit_file instead. " +
            "Requires human confirmation before the file is written. " +
            "Before calling this tool, verify the parent directory exists and that the file does not already exist " +
            "(use read_file on the target path — a not-found error confirms it is safe to create).",
          schema: z.object({
            path: z.string().describe("Absolute or relative path of the new file to create"),
            content: z.string().describe("Full text content to write into the new file"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("edit_file", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const payload: DeferHitlToolResult = {
            defer_hitl: true,
            summary: buildHitlInterruptSummary("edit_file", input as Record<string, unknown>),
            args: input as Record<string, unknown>,
          };
          return JSON.stringify(payload);
        },
        {
          name: "edit_file",
          description:
            "Use this tool to replace exactly one occurrence of a specific string inside an existing file. " +
            "This is the correct tool for targeted code edits: replace a function body, update a config value, fix a bug. " +
            "Do NOT use bash with sed/awk to edit files — use edit_file instead. " +
            "Before calling, always call read_file first to confirm the exact current content and copy the precise substring for old_string. " +
            "The match is literal and case-sensitive; old_string must appear exactly once in the file — zero or multiple matches abort the operation without any changes. " +
            "Requires human confirmation before the file is modified.",
          schema: z.object({
            path: z.string().describe("Absolute or relative path to the file to edit"),
            old_string: z.string().describe("The exact substring to find (must match exactly once, case-sensitive)"),
            new_string: z.string().describe("The string to replace old_string with"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bash", ctx)) {
    tools.push(
      tool(
        async () =>
          JSON.stringify({
            control: "hitl_required",
            message:
              "This handler does not execute commands. The agent runs bash only after human approval in executeApprovedSideEffect.",
          }),
        {
          name: "bash",
          description:
            "Use this tool to execute bash commands that require OS-level features: piping, process management, " +
            "environment inspection, package installation, running scripts, etc. " +
            "Do NOT use bash tool to read files (use read_file instead of cat/head/tail). " +
            "Do NOT use bash tool to edit files (use edit_file instead of sed/awk). " +
            "Do NOT use bash tool to create new files with content (use write_file instead of echo/tee redirection). " +
            "The execution environment is Linux under WSL2, using bash.",
          schema: z.object({
            prompt: z.string().describe("The bash command to execute"),
            terminal: z
              .string()
              .optional()
              .describe("Optional correlation id for display only (not a persistent shell session)"),
            cwd: z.string().optional().describe("Optional working directory"),
          }),
        }
      )
    );
  }

  return tools;
}
