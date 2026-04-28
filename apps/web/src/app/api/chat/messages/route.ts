import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50;

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");
    const beforeCreatedAt = searchParams.get("beforeCreatedAt");
    const beforeId = searchParams.get("beforeId");

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    if ((beforeCreatedAt && !beforeId) || (!beforeCreatedAt && beforeId)) {
      return NextResponse.json(
        { error: "beforeCreatedAt and beforeId must be provided together" },
        { status: 400 }
      );
    }

    if (beforeCreatedAt) {
      const parsed = new Date(beforeCreatedAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: "beforeCreatedAt must be a valid date" },
          { status: 400 }
        );
      }
    }

    const { data: session } = await supabase
      .from("agent_sessions")
      .select("id, status, title")
      .eq("id", sessionId)
      .eq("user_id", user.id)
      .eq("channel", "web")
      .single();

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    let query = supabase
      .from("agent_messages")
      .select("id, role, content, created_at, structured_payload")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE + 1);

    if (beforeCreatedAt && beforeId) {
      const normalizedTimestamp = new Date(beforeCreatedAt).toISOString();
      query = query.or(
        `created_at.lt.${normalizedTimestamp},and(created_at.eq.${normalizedTimestamp},id.lt.${beforeId})`
      );
    }

    const { data, error } = await query;
    if (error) {
      console.error("Messages API error:", error);
      return NextResponse.json({ error: "Failed to load messages" }, { status: 500 });
    }

    const rows = data ?? [];
    const hasMoreOlder = rows.length > PAGE_SIZE;
    const messages = rows.slice(0, PAGE_SIZE).reverse();

    return NextResponse.json({
      messages,
      hasMoreOlder,
      status: session.status,
      title: session.title,
    });
  } catch (error) {
    console.error("Messages API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
