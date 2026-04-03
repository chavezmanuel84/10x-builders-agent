import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt, updateToolCallStatus } from "@agents/db";
import { executeGitHubTool } from "@agents/agent";

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

    const { data: integration } = await db
      .from("user_integrations")
      .select("encrypted_tokens")
      .eq("user_id", user.id)
      .eq("provider", "github")
      .eq("status", "active")
      .single();

    if (!integration?.encrypted_tokens) {
      await updateToolCallStatus(db, toolCallId, "failed", {
        error: "GitHub not connected",
      });
      return NextResponse.json(
        { error: "GitHub integration not found" },
        { status: 400 }
      );
    }

    const githubToken = decrypt(integration.encrypted_tokens);

    try {
      const result = await executeGitHubTool(
        toolCall.tool_name,
        toolCall.arguments_json,
        githubToken
      );
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
