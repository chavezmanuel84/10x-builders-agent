import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt } from "@agents/db";
import { buildSystemPrompt, resumeAgent } from "@agents/agent";
import type {
  HitlResumeDecision,
  UserIntegration,
  UserToolSetting,
} from "@agents/types";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action, sessionId, rejectMessage } = body;
    if (!sessionId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();
    const { data: activeSession } = await supabase
      .from("agent_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .maybeSingle();
    if (!activeSession) {
      return NextResponse.json(
        { error: "Session no activa o invalida para confirmacion" },
        { status: 409 }
      );
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("agent_system_prompt, timezone")
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

    const decision: HitlResumeDecision =
      action === "approve"
        ? { decision: "approve" }
        : {
            decision: "reject",
            message:
              typeof rejectMessage === "string" && rejectMessage.trim()
                ? rejectMessage.trim()
                : "Acción rechazada por el usuario.",
          };

    const result = await resumeAgent({
      userId: user.id,
      sessionId,
      systemPrompt: buildSystemPrompt((profile?.agent_system_prompt as string) ?? "Eres un asistente útil."),
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })) as UserToolSetting[],
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })) as UserIntegration[],
      githubToken,
      googleCalendarToken,
      userTimezone: (profile?.timezone as string) ?? "UTC",
      decision,
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    return NextResponse.json({
      ok: true,
      response: result.response,
      pendingConfirmation: result.pendingConfirmation,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
