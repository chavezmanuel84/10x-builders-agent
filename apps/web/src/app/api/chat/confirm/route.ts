import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import { executeToolCallAction } from "@/lib/tool-call-actions";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action, sessionId } = await request.json();
    if (!toolCallId || !sessionId || !["approve", "reject"].includes(action)) {
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

    const result = await executeToolCallAction({
      db,
      toolCallId,
      action,
      expectedUserId: user.id,
      expectedSessionId: sessionId,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.statusCode });
    }
    if (result.result) {
      return NextResponse.json({ ok: true, result: result.result });
    }
    return NextResponse.json({ ok: true, message: result.message ?? "Accion actualizada." });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
