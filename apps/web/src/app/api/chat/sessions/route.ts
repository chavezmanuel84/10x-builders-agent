import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await supabase
      .from("agent_sessions")
      .select("id, title, status, created_at, updated_at")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Sessions list API error:", error);
      return NextResponse.json({ error: "Failed to load sessions" }, { status: 500 });
    }

    return NextResponse.json({ sessions: data ?? [] });
  } catch (error) {
    console.error("Sessions list API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
