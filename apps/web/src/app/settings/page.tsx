import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NavActionButton } from "@/components/ui/nav-action-button";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const { data: toolSettings } = await supabase
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", user.id);

  const { data: telegramAccount } = await supabase
    .from("telegram_accounts")
    .select("*")
    .eq("user_id", user.id)
    .single();

  const { data: githubIntegration } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "github")
    .eq("status", "active")
    .single();

  const { data: googleCalendarIntegration } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "google_calendar")
    .eq("status", "active")
    .single();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-white/80 dark:border-neutral-800 dark:bg-neutral-950/95 dark:supports-[backdrop-filter]:bg-neutral-950/80">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <h1 className="text-lg font-semibold">Ajustes</h1>
          <NavActionButton as="a" href="/chat" icon={ArrowLeft}>
            Volver al chat
          </NavActionButton>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8">
        <SettingsForm
          userId={user.id}
          profile={profile}
          toolSettings={toolSettings ?? []}
          telegramLinked={!!telegramAccount}
          githubConnected={!!githubIntegration}
          googleCalendarConnected={!!googleCalendarIntegration}
        />
      </main>
    </div>
  );
}
