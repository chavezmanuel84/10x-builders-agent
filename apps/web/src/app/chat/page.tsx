import { redirect } from "next/navigation";
import { LogOut, Settings } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NavActionButton } from "@/components/ui/nav-action-button";
import { ChatInterface } from "./chat-interface";
import { SessionsSidebar, type SidebarSession } from "./sessions-sidebar";

interface ChatPageProps {
  searchParams: Promise<{ sessionId?: string | string[] }>;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_completed) redirect("/onboarding");

  const params = await searchParams;
  const requestedSessionIdRaw = params?.sessionId;
  const requestedSessionId = Array.isArray(requestedSessionIdRaw)
    ? requestedSessionIdRaw[0]
    : requestedSessionIdRaw;

  const { data: sessionsData } = await supabase
    .from("agent_sessions")
    .select("id, title, status, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("channel", "web")
    .order("created_at", { ascending: false });

  const sessions = (sessionsData ?? []) as SidebarSession[];

  let selectedSession: SidebarSession | null = null;
  if (requestedSessionId) {
    const match = sessions.find((s) => s.id === requestedSessionId);
    if (!match) redirect("/chat");
    selectedSession = match;
  } else {
    selectedSession = sessions.find((s) => s.status === "active") ?? null;
  }

  let sessionMessages: Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
    structured_payload?: unknown;
  }> = [];
  let initialHasMoreOlder = false;
  if (selectedSession?.id) {
    const { data } = await supabase
      .from("agent_messages")
      .select("id, role, content, created_at, structured_payload")
      .eq("session_id", selectedSession.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(51);
    const page = data ?? [];
    initialHasMoreOlder = page.length > 50;
    sessionMessages = page.slice(0, 50).reverse();
  }

  const sessionStatus = selectedSession?.status ?? null;

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
      <div className="flex min-h-0 flex-1">
        <SessionsSidebar
          initialSessions={sessions}
          currentSessionId={selectedSession?.id ?? null}
        />
        <ChatInterface
          key={selectedSession?.id ?? "no-session"}
          agentName={profile.agent_name as string}
          initialMessages={sessionMessages}
          sessionId={selectedSession?.id ?? null}
          sessionStatus={sessionStatus}
          initialHasMoreOlder={initialHasMoreOlder}
        />
      </div>
    </div>
  );
}
