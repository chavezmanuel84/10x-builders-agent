"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

interface Props {
  userId: string;
  profile: Record<string, unknown> | null;
  toolSettings: Array<{ tool_id: string; enabled: boolean }>;
  telegramLinked: boolean;
  githubConnected: boolean;
  googleCalendarConnected: boolean;
}

const TOOL_IDS = [
  "get_user_preferences",
  "list_enabled_tools",
  "get_current_datetime",
  "create_cronjob",
  "github_list_repos",
  "github_list_issues",
  "github_create_issue",
  "github_create_repo",
  "gcal_list_events",
  "gcal_query_events",
  "gcal_create_event",
  "read_file",
  "list_directory",
  "write_file",
  "edit_file",
  "bash",
];

export function SettingsForm({ userId, profile, toolSettings, telegramLinked, githubConnected, googleCalendarConnected }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [ghConnected, setGhConnected] = useState(githubConnected);
  const [gcalConnected, setGcalConnected] = useState(googleCalendarConnected);
  const [disconnecting, setDisconnecting] = useState(false);
  const [gcalDisconnecting, setGcalDisconnecting] = useState(false);

  const [name, setName] = useState((profile?.name as string) ?? "");
  const [agentName, setAgentName] = useState((profile?.agent_name as string) ?? "Agente");
  const [systemPrompt, setSystemPrompt] = useState(
    (profile?.agent_system_prompt as string) ?? ""
  );
  const [enabledTools, setEnabledTools] = useState<string[]>(
    toolSettings.filter((t) => t.enabled).map((t) => t.tool_id)
  );
  const [linkCode, setLinkCode] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);

    await supabase.from("profiles").update({
      name,
      agent_name: agentName,
      agent_system_prompt: systemPrompt.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", userId);

    for (const toolId of TOOL_IDS) {
      await supabase.from("user_tool_settings").upsert(
        {
          user_id: userId,
          tool_id: toolId,
          enabled: enabledTools.includes(toolId),
          config_json: {},
        },
        { onConflict: "user_id,tool_id" }
      );
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  async function generateTelegramCode() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await supabase.from("telegram_link_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    setLinkCode(code);
  }

  return (
    <div className="space-y-8">
      {/* Profile */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Perfil</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      </section>

      {/* Agent */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Agente</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre del agente</label>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={50}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Instrucciones</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 500))}
            rows={4}
            maxLength={500}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 text-right mt-1">{systemPrompt.length}/500</p>
        </div>
      </section>

      {/* Tools */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Herramientas</h2>
        <div className="space-y-2">
          {TOOL_IDS.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabledTools.includes(id)}
                onChange={() => toggleTool(id)}
                className="rounded border-neutral-300"
              />
              {id}
            </label>
          ))}
        </div>
      </section>

      {/* GitHub */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">GitHub</h2>
        {ghConnected ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              GitHub conectado
            </span>
            <button
              onClick={async () => {
                setDisconnecting(true);
                await fetch("/api/integrations/github/disconnect", { method: "POST" });
                setGhConnected(false);
                setDisconnecting(false);
                router.refresh();
              }}
              disabled={disconnecting}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {disconnecting ? "Desconectando..." : "Desconectar"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de GitHub para que el agente pueda trabajar con tus repositorios e issues.
            </p>
            <a
              href="/api/integrations/github/connect"
              className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              Conectar GitHub
            </a>
          </div>
        )}
      </section>

      {/* Google Calendar */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Google Calendar</h2>
        {gcalConnected ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
              Google Calendar conectado
            </span>
            <button
              onClick={async () => {
                setGcalDisconnecting(true);
                await fetch("/api/integrations/google-calendar/disconnect", { method: "POST" });
                setGcalConnected(false);
                setGcalDisconnecting(false);
                router.refresh();
              }}
              disabled={gcalDisconnecting}
              className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {gcalDisconnecting ? "Desconectando..." : "Desconectar"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de Google Calendar para que el agente pueda consultar y crear eventos.
            </p>
            <a
              href="/api/integrations/google-calendar/connect"
              className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none">
                <path d="M21.35 11.1h-9.18v2.73h5.51c-.24 1.27-.98 2.34-2.09 3.06v2.54h3.38c1.97-1.82 3.11-4.5 3.11-7.59 0-.52-.05-1.02-.14-1.5l-.59-.24z" fill="#4285F4"/>
                <path d="M12.17 22c2.84 0 5.22-.94 6.96-2.57l-3.38-2.54c-.94.63-2.15 1-3.58 1-2.75 0-5.08-1.86-5.91-4.36H2.76v2.62A10.49 10.49 0 0012.17 22z" fill="#34A853"/>
                <path d="M6.26 13.53a6.2 6.2 0 010-3.96V6.95H2.76a10.49 10.49 0 000 9.2l3.5-2.62z" fill="#FBBC05"/>
                <path d="M12.17 5.21c1.55 0 2.94.53 4.03 1.58l3.02-3.02C17.38 2.09 15.01 1 12.17 1 7.93 1 4.28 3.48 2.76 6.95l3.5 2.62c.83-2.5 3.16-4.36 5.91-4.36z" fill="#EA4335"/>
              </svg>
              Conectar Google Calendar
            </a>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Telegram</h2>
        {telegramLinked ? (
          <p className="text-sm text-green-600">Cuenta de Telegram vinculada.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Vincula tu cuenta de Telegram para usar el agente desde allí.
            </p>
            {linkCode ? (
              <div className="rounded-md bg-neutral-50 p-4 dark:bg-neutral-900">
                <p className="text-sm">
                  Envía este código al bot en Telegram:{" "}
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-sm font-mono font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    /link {linkCode}
                  </code>
                </p>
                <p className="text-xs text-neutral-400 mt-1">Expira en 10 minutos.</p>
              </div>
            ) : (
              <button
                onClick={generateTelegramCode}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar código de vinculación
              </button>
            )}
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Guardado correctamente.</span>
        )}
      </div>
    </div>
  );
}
