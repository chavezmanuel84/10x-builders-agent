import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  addMessage,
  createServerClient,
  decrypt,
  getRecentPendingContexts,
  updateMessageContextStatus,
} from "@agents/db";
import { resolvePendingContextReply, runAgent } from "@agents/agent";
import { executeToolCallAction } from "@/lib/tool-call-actions";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select("agent_system_prompt, agent_name, timezone")
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await supabase
      .from("user_integrations")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active");

    // Decrypt GitHub token if available
    let githubToken: string | undefined;
    const ghIntegration = (integrations ?? []).find(
      (i: Record<string, unknown>) => i.provider === "github"
    );
    if (ghIntegration && (ghIntegration as Record<string, unknown>).encrypted_tokens) {
      try {
        githubToken = decrypt(
          (ghIntegration as Record<string, unknown>).encrypted_tokens as string
        );
      } catch {
        console.error("Failed to decrypt GitHub token for user", user.id);
      }
    }

    // Decrypt Google Calendar token if available
    let googleCalendarToken: string | undefined;
    const gcalIntegration = (integrations ?? []).find(
      (i: Record<string, unknown>) => i.provider === "google_calendar"
    );
    if (gcalIntegration && (gcalIntegration as Record<string, unknown>).encrypted_tokens) {
      try {
        googleCalendarToken = decrypt(
          (gcalIntegration as Record<string, unknown>).encrypted_tokens as string
        );
      } catch {
        console.error("Failed to decrypt Google Calendar token for user", user.id);
      }
    }

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);

    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }

    if (!session) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    const pendingContexts = await getRecentPendingContexts(db, session.id);
    const pendingResolution = resolvePendingContextReply(message, session.id, pendingContexts);

    if (pendingResolution.kind === "no_match" || pendingResolution.kind === "ambiguous") {
      await addMessage(db, session.id, "user", message);
      await addMessage(db, session.id, "assistant", pendingResolution.clarification);
      return NextResponse.json({
        response: pendingResolution.clarification,
        pendingConfirmation: null,
        toolCalls: [],
      });
    }

    if (pendingResolution.kind === "resolve_pending_confirmation") {
      await addMessage(db, session.id, "user", message);
      const confirmResult = await executeToolCallAction({
        db,
        toolCallId: pendingResolution.toolCallId,
        action: pendingResolution.action,
        expectedUserId: user.id,
      });
      const responseText =
        confirmResult.result
          ? `Accion ejecutada: ${JSON.stringify(confirmResult.result)}`
          : (confirmResult.message ??
            confirmResult.error ??
            "No pude resolver la confirmacion. Aclara la accion que deseas.");
      await addMessage(db, session.id, "assistant", responseText);
      return NextResponse.json({
        response: responseText,
        pendingConfirmation: null,
        toolCalls: [],
      });
    }

    let contextInstruction: string | undefined;
    let messageForAgent = message;
    if (pendingResolution.kind === "resolve_pending_input") {
      await updateMessageContextStatus(db, pendingResolution.messageId, "resolved");
      messageForAgent = pendingResolution.rewrittenMessage;
      contextInstruction =
        "Solo continua el contexto activo indicado por el ultimo mensaje del usuario y evita reutilizar acciones viejas.";
    }

    const result = await runAgent({
      message: messageForAgent,
      userId: user.id,
      sessionId: session.id,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
      googleCalendarToken,
      userTimezone: (profile?.timezone as string) ?? "UTC",
      contextInstruction,
    });

    return NextResponse.json({
      response: result.pendingConfirmation ? null : result.response,
      pendingConfirmation: result.pendingConfirmation,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
