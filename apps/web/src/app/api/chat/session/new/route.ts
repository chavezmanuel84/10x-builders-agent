import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { closeActiveSession, createServerClient, createSession } from "@agents/db";
import { flushSessionMemories } from "@agents/agent";

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
    const closedSessionIds = await closeActiveSession(db, user.id, "web");
    const session = await createSession(db, user.id, "web");

    for (const closedSessionId of closedSessionIds) {
      void flushSessionMemories({
        db,
        userId: user.id,
        sessionId: closedSessionId,
      }).catch((error) => {
        console.error("Memory flush failed on web session close", {
          userId: user.id,
          closedSessionId,
          error,
        });
      });
    }

    return NextResponse.json({ sessionId: session.id });
  } catch (error) {
    console.error("New session API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
