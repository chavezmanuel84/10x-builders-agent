import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt, updateToolCallStatus } from "@agents/db";
import { executeGitHubTool, executeGoogleCalendarTool } from "@agents/agent";

function getProviderForTool(toolName: string): string | null {
  if (toolName.startsWith("github_")) return "github";
  if (toolName.startsWith("gcal_")) return "google_calendar";
  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();
    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: toolCall } = await db
      .from("tool_calls")
      .select("*, agent_sessions!inner(user_id)")
      .eq("id", toolCallId)
      .eq("status", "pending_confirmation")
      .single();

    if (!toolCall) {
      return NextResponse.json(
        { error: "Tool call not found or already resolved" },
        { status: 404 }
      );
    }

    const sessionUserId = (toolCall.agent_sessions as Record<string, unknown>)
      .user_id as string;
    if (sessionUserId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (action === "reject") {
      await updateToolCallStatus(db, toolCallId, "rejected");
      return NextResponse.json({ ok: true, message: "Acción cancelada." });
    }

    const provider = getProviderForTool(toolCall.tool_name);
    if (!provider) {
      await updateToolCallStatus(db, toolCallId, "failed", {
        error: `Unknown provider for tool: ${toolCall.tool_name}`,
      });
      return NextResponse.json({ error: "Unknown tool provider" }, { status: 400 });
    }

    const { data: integration } = await db
      .from("user_integrations")
      .select("encrypted_tokens")
      .eq("user_id", user.id)
      .eq("provider", provider)
      .eq("status", "active")
      .single();

    if (!integration?.encrypted_tokens) {
      await updateToolCallStatus(db, toolCallId, "failed", {
        error: `${provider} not connected`,
      });
      return NextResponse.json(
        { error: `${provider} integration not found` },
        { status: 400 }
      );
    }

    const token = decrypt(integration.encrypted_tokens);

    try {
      let result: Record<string, unknown>;
      if (provider === "github") {
        result = await executeGitHubTool(
          toolCall.tool_name,
          toolCall.arguments_json,
          token
        );
      } else {
        result = await executeGoogleCalendarTool(
          toolCall.tool_name,
          toolCall.arguments_json,
          token
        );
      }
      await updateToolCallStatus(db, toolCallId, "executed", result);
      return NextResponse.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution failed";
      await updateToolCallStatus(db, toolCallId, "failed", { error: message });
      return NextResponse.json({ ok: true, error: message });
    }
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
