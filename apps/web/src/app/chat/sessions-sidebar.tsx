"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { NavActionButton } from "@/components/ui/nav-action-button";
import { formatRelativeShort } from "@/lib/format-date";

export interface SidebarSession {
  id: string;
  title: string | null;
  status: "active" | "closed";
  created_at: string;
  updated_at: string;
}

interface Props {
  initialSessions: SidebarSession[];
  currentSessionId: string | null;
}

const FALLBACK_TITLE = "Sesión sin nombre";

function getDisplayTitle(session: SidebarSession): string {
  const trimmed = session.title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : FALLBACK_TITLE;
}

export function SessionsSidebar({ initialSessions, currentSessionId }: Props) {
  const router = useRouter();
  const [sessions, setSessions] = useState<SidebarSession[]>(initialSessions);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  const { activeSession, previousSessions } = useMemo(() => {
    const active = sessions.find((s) => s.status === "active") ?? null;
    const previous = sessions.filter((s) => s.id !== active?.id);
    return { activeSession: active, previousSessions: previous };
  }, [sessions]);

  async function handleNewSession() {
    if (creating) return;
    const confirmed = window.confirm(
      "Se cerrará la sesión actual y se abrirá una nueva. ¿Continuar?"
    );
    if (!confirmed) return;

    setCreating(true);
    try {
      const res = await fetch("/api/chat/session/new", { method: "POST" });
      if (!res.ok) throw new Error("create_failed");
      router.push("/chat");
      router.refresh();
    } catch {
      window.alert("No se pudo crear una nueva sesión. Intenta de nuevo.");
    } finally {
      setCreating(false);
    }
  }

  function handleSelectSession(id: string, isActive: boolean) {
    if (id === currentSessionId) return;
    if (isActive) {
      router.push("/chat");
    } else {
      router.push(`/chat?sessionId=${encodeURIComponent(id)}`);
    }
  }

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/40 dark:border-neutral-800 dark:bg-neutral-900/30 md:flex">
      <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-3 dark:border-neutral-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Sesiones
        </h2>
        <NavActionButton
          variant="ghost"
          icon={Plus}
          onClick={handleNewSession}
          disabled={creating}
          aria-label="Crear nueva sesión"
          title="Crear nueva sesión"
        >
          <span className="sr-only">Nueva</span>
        </NavActionButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3">
        <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Sesión actual
        </div>
        {activeSession ? (
          <SessionRow
            session={activeSession}
            isSelected={
              currentSessionId === activeSession.id || currentSessionId === null
            }
            badge="Active"
            onClick={() => handleSelectSession(activeSession.id, true)}
          />
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 px-3 py-3 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No hay sesión activa.
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-4 flex items-center justify-between rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60"
          aria-expanded={expanded}
        >
          <span className="inline-flex items-center gap-1">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Sesiones anteriores
          </span>
          <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            {previousSessions.length}
          </span>
        </button>

        {expanded && (
          <div className="mt-1 flex flex-col gap-1">
            {previousSessions.length === 0 ? (
              <div className="px-3 py-3 text-xs text-neutral-500 dark:text-neutral-400">
                Aún no hay sesiones anteriores.
              </div>
            ) : (
              previousSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  isSelected={currentSessionId === session.id}
                  onClick={() => handleSelectSession(session.id, false)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  isSelected,
  badge,
  onClick,
}: {
  session: SidebarSession;
  isSelected: boolean;
  badge?: string;
  onClick: () => void;
}) {
  const title = getDisplayTitle(session);
  const relative = formatRelativeShort(session.updated_at ?? session.created_at);
  const baseClasses =
    "w-full rounded-md px-3 py-2 text-left text-sm transition-colors";
  const stateClasses = isSelected
    ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
    : "hover:bg-neutral-100 text-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800/60";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${baseClasses} ${stateClasses}`}
      aria-current={isSelected ? "page" : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{title}</span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            {badge}
          </span>
        ) : null}
      </div>
      {relative ? (
        <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          {relative}
        </div>
      ) : null}
    </button>
  );
}
