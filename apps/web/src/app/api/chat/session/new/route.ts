import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, startNewSession } from "@agents/db";

export async function POST() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = createServerClient();
    const session = await startNewSession(db, user.id, "web");
    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    console.error("New session API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
