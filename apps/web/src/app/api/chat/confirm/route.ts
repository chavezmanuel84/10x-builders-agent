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

    const { toolCallId, action } = await request.json();
    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();

    const result = await executeToolCallAction({
      db,
      toolCallId,
      action,
      expectedUserId: user.id,
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
