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
    id: "get_current_path",
    name: "get_current_path",
    description:
      "Returns the agent's workspace root and effective working directory. " +
      "Use this instead of running bash pwd to answer questions like 'what is my current path?' or 'where am I?'. " +
      "Does not require confirmation and does not execute any shell command.",
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
    id: "read_file",
    name: "read_file",
    description:
      "Use this tool to read the exact, literal content of a file on disk — including source code, config files, or any text file. " +
      "Do NOT use bash just to read a file (e.g. cat, head); use read_file instead. " +
      "Use bash only when you need shell features such as piping, globbing, or command substitution. " +
      "Supports optional offset (1-indexed line number to start from) and limit (max lines to return) for large files; omit both to read the whole file. " +
      "Call this tool before any write or edit operation to verify the current state of the file.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to read" },
        offset: { type: "number", description: "1-indexed line number to start reading from (optional)" },
        limit: { type: "number", description: "Maximum number of lines to return (optional)" },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Use this tool to create a brand-new file with the given content. " +
      "This tool is ONLY for files that do not yet exist on disk — it will refuse to overwrite an existing file. " +
      "To update an existing file use edit_file instead. " +
      "Requires human confirmation before the file is written. " +
      "Before calling this tool, verify the parent directory exists and that the file does not already exist " +
      "(use read_file on the target path — a not-found error confirms it is safe to create).",
    risk: "medium",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path of the new file to create" },
        content: { type: "string", description: "Full text content to write into the new file" },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Use this tool to replace exactly one occurrence of a specific string inside an existing file. " +
      "This is the correct tool for targeted code edits: replace a function body, update a config value, fix a bug. " +
      "Do NOT use bash with sed/awk to edit files — use edit_file instead. " +
      "Before calling, always call read_file first to confirm the exact current content and copy the precise substring for old_string. " +
      "The match is literal and case-sensitive; old_string must appear exactly once in the file — zero or multiple matches abort the operation without any changes. " +
      "Requires human confirmation before the file is modified.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to edit" },
        old_string: { type: "string", description: "The exact substring to find (must match exactly once, case-sensitive)" },
        new_string: { type: "string", description: "The string to replace old_string with" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    id: "list_directory",
    name: "list_directory",
    description:
      "Use this tool to list the contents of a directory — files, subdirectories, and symlinks. " +
      "Use this instead of bash ls or find to explore the workspace structure; no confirmation needed. " +
      "Set depth=1 (default) for a flat listing, up to depth=3 for a recursive tree (capped). " +
      "Do NOT use bash just to list a directory; use list_directory instead.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the directory to list" },
        depth: {
          type: "number",
          description: "How many levels deep to recurse (1–3, default 1)",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "change_directory",
    name: "change_directory",
    description:
      "Changes the agent's current working directory for this session. " +
      "Use this to navigate to a subdirectory before running related bash commands or file operations. " +
      "The path must exist inside the workspace root. " +
      "Does not require confirmation.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the directory to navigate to",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Use this tool to execute bash commands that require OS-level features: piping, process management, " +
      "environment inspection, package installation, running scripts, etc. " +
      "Do NOT use bash tool to read files (use read_file instead of cat/head/tail). " +
      "Do NOT use bash tool to edit files (use edit_file instead of sed/awk). " +
      "Do NOT use bash tool to create new files with content (use write_file instead of echo/tee redirection). " +
      "Do NOT use bash tool to list directories (use list_directory instead of ls/find). " +
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
