import { decrypt, type DbClient, updateToolCallStatus, closeActiveContextsByToolCallId } from "@agents/db";
import { executeGitHubTool, executeGoogleCalendarTool } from "@agents/agent";

type ToolAction = "approve" | "reject";

function getProviderForTool(toolName: string): "github" | "google_calendar" | null {
  if (toolName.startsWith("github_")) return "github";
  if (toolName.startsWith("gcal_")) return "google_calendar";
  return null;
}

interface ExecuteToolCallActionInput {
  db: DbClient;
  toolCallId: string;
  action: ToolAction;
  expectedUserId?: string;
  expectedSessionId?: string;
}

interface ExecuteToolCallActionResult {
  ok: boolean;
  statusCode: number;
  message?: string;
  error?: string;
  result?: Record<string, unknown>;
  toolCall?: {
    id: string;
    session_id: string;
    tool_name: string;
    arguments_json: Record<string, unknown>;
    agent_sessions: { user_id: string };
  };
}

export async function executeToolCallAction(
  input: ExecuteToolCallActionInput
): Promise<ExecuteToolCallActionResult> {
  const { db, toolCallId, action, expectedUserId, expectedSessionId } = input;

  let query = db
    .from("tool_calls")
    .select("*, agent_sessions!inner(user_id)")
    .eq("id", toolCallId)
    .eq("status", "pending_confirmation");
  if (expectedSessionId) {
    query = query.eq("session_id", expectedSessionId);
  }
  const { data: toolCall } = await query.single();

  if (!toolCall) {
    return {
      ok: false,
      statusCode: 404,
      error: "Tool call not found or already resolved",
    };
  }

  const ownerUserId = (toolCall.agent_sessions as Record<string, unknown>).user_id as string;
  if (expectedUserId && ownerUserId !== expectedUserId) {
    return { ok: false, statusCode: 403, error: "Forbidden" };
  }
  if (expectedSessionId && toolCall.session_id !== expectedSessionId) {
    return { ok: false, statusCode: 409, error: "Session mismatch for tool confirmation" };
  }

  if (action === "reject") {
    await updateToolCallStatus(db, toolCallId, "rejected", undefined, toolCall.session_id);
    await closeActiveContextsByToolCallId(db, toolCall.session_id, toolCallId, "rejected");
    return {
      ok: true,
      statusCode: 200,
      message: "Accion cancelada.",
      toolCall: toolCall as ExecuteToolCallActionResult["toolCall"],
    };
  }

  const provider = getProviderForTool(toolCall.tool_name);
  if (!provider) {
    await updateToolCallStatus(
      db,
      toolCallId,
      "failed",
      {
      error: `Unknown provider for tool: ${toolCall.tool_name}`,
      },
      toolCall.session_id
    );
    await closeActiveContextsByToolCallId(db, toolCall.session_id, toolCallId, "failed");
    return { ok: false, statusCode: 400, error: "Unknown tool provider" };
  }

  const { data: integration } = await db
    .from("user_integrations")
    .select("encrypted_tokens")
    .eq("user_id", ownerUserId)
    .eq("provider", provider)
    .eq("status", "active")
    .single();

  if (!integration?.encrypted_tokens) {
    await updateToolCallStatus(
      db,
      toolCallId,
      "failed",
      {
        error: `${provider} not connected`,
      },
      toolCall.session_id
    );
    await closeActiveContextsByToolCallId(db, toolCall.session_id, toolCallId, "failed");
    return {
      ok: false,
      statusCode: 400,
      error: `${provider} integration not found`,
    };
  }

  const token = decrypt(integration.encrypted_tokens);
  try {
    await updateToolCallStatus(db, toolCallId, "approved", undefined, toolCall.session_id);

    let result: Record<string, unknown>;
    if (provider === "github") {
      result = await executeGitHubTool(toolCall.tool_name, toolCall.arguments_json, token);
    } else {
      const { data: userProfile } = await db
        .from("profiles")
        .select("timezone")
        .eq("id", ownerUserId)
        .single();
      const tz = (userProfile?.timezone as string) ?? "UTC";
      result = await executeGoogleCalendarTool(toolCall.tool_name, toolCall.arguments_json, token, tz);
    }
    await updateToolCallStatus(db, toolCallId, "executed", result, toolCall.session_id);
    await closeActiveContextsByToolCallId(db, toolCall.session_id, toolCallId, "executed");
    return {
      ok: true,
      statusCode: 200,
      result,
      toolCall: toolCall as ExecuteToolCallActionResult["toolCall"],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execution failed";
    await updateToolCallStatus(
      db,
      toolCallId,
      "failed",
      { error: message },
      toolCall.session_id
    );
    await closeActiveContextsByToolCallId(db, toolCall.session_id, toolCallId, "failed");
    return { ok: false, statusCode: 200, error: message };
  }
}
