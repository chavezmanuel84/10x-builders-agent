import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Short description" },
        private: { type: "boolean", description: "Whether the repo is private" },
      },
      required: ["name"],
    },
  },
  {
    id: "gcal_list_events",
    name: "gcal_list_events",
    description:
      "Lists the user's upcoming Google Calendar events for a given day. Defaults to today if no date is provided.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "ISO date (YYYY-MM-DD). Defaults to today.",
        },
      },
      required: [],
    },
  },
  {
    id: "gcal_query_events",
    name: "gcal_query_events",
    description:
      "Queries Google Calendar events within a date range.",
    risk: "low",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    id: "gcal_create_event",
    name: "gcal_create_event",
    description:
      "Creates a new event on the user's Google Calendar. Requires confirmation. Attendees must be specified by email address.",
    risk: "medium",
    requires_integration: "google_calendar",
    parameters_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start datetime (ISO 8601)" },
        end: { type: "string", description: "End datetime (ISO 8601)" },
        description: { type: "string", description: "Event description" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses",
        },
      },
      required: ["title", "start", "end"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Use this tool when you need to execute bash commands and interact with the operating system. " +
      "This tool executes commands and returns the command output. " +
      "The execution environment is Linux under WSL2, using bash.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The bash command to execute" },
        terminal: {
          type: "string",
          description: "Optional correlation id for display only (not a persistent shell session)",
        },
        cwd: { type: "string", description: "Optional working directory" },
      },
      required: ["prompt"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
