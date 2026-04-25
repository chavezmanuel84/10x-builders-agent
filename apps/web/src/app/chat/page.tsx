import { redirect } from "next/navigation";
import { LogOut, Settings } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NavActionButton } from "@/components/ui/nav-action-button";
import { ChatInterface } from "./chat-interface";

export default async function ChatPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_completed) redirect("/onboarding");

  const { data: messages } = await supabase
    .from("agent_sessions")
    .select("id")
    .eq("user_id", user.id)
    .eq("channel", "web")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  let sessionMessages: Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
    structured_payload?: unknown;
  }> = [];
  let initialHasMoreOlder = false;
  if (messages?.id) {
    const { data } = await supabase
      .from("agent_messages")
      .select("id, role, content, created_at, structured_payload")
      .eq("session_id", messages.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(51);
    const page = data ?? [];
    initialHasMoreOlder = page.length > 50;
    sessionMessages = page.slice(0, 50).reverse();
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
            {(profile.agent_name as string)?.[0]?.toUpperCase() ?? "A"}
          </div>
          <div>
            <h1 className="text-sm font-semibold">{profile.agent_name as string}</h1>
            <p className="text-xs text-neutral-500">Chat web</p>
          </div>
        </div>
        <div className="flex gap-2">
          <NavActionButton as="a" href="/settings" icon={Settings}>
            Ajustes
          </NavActionButton>
          <form action="/api/auth/signout" method="POST">
            <NavActionButton icon={LogOut} type="submit">
              Salir
            </NavActionButton>
          </form>
        </div>
      </header>
      <ChatInterface
        agentName={profile.agent_name as string}
        initialMessages={sessionMessages}
        sessionId={messages?.id ?? null}
        initialHasMoreOlder={initialHasMoreOlder}
      />
    </div>
  );
}
