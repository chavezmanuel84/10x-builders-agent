import type { ConversationContextPayload } from "@agents/types";

export interface PendingContextCandidate {
  message_id: string;
  session_id: string;
  created_at: string;
  payload: ConversationContextPayload;
}

interface PendingSignal {
  pendingField: "visibility";
  value: "public" | "private";
}

export type PendingResolutionResult =
  | { kind: "no_signal" }
  | { kind: "no_match"; clarification: string }
  | { kind: "ambiguous"; clarification: string }
  | {
      kind: "resolve_pending_input";
      messageId: string;
      payload: ConversationContextPayload;
      normalizedValue: "public" | "private";
      rewrittenMessage: string;
    };

function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parsePendingSignal(message: string): PendingSignal | null {
  const normalized = normalizeText(message);
  if (normalized === "publico" || normalized === "publica") {
    return { pendingField: "visibility", value: "public" };
  }
  if (normalized === "privado" || normalized === "privada") {
    return { pendingField: "visibility", value: "private" };
  }
  return null;
}

function isActivePayload(payload: ConversationContextPayload): boolean {
  return payload.context_status === "active";
}

function isPendingFieldCompatible(
  payload: ConversationContextPayload,
  signal: PendingSignal
): boolean {
  if (signal.pendingField === "visibility") {
    const field = normalizeText(payload.pending_field ?? "");
    return (
      payload.context_type === "pending_input" &&
      (field === "visibility" || field === "repo_visibility")
    );
  }

  return false;
}

function buildVisibilityRewrittenMessage(
  payload: ConversationContextPayload,
  normalizedValue: "public" | "private"
): string {
  const repoName =
    typeof payload.entity?.repo_name === "string"
      ? payload.entity.repo_name
      : "el repositorio";
  const privateFlag = normalizedValue === "private" ? "true" : "false";
  return [
    `Resuelve unicamente el contexto activo de ${payload.tool_name}.`,
    `Repositorio objetivo: "${repoName}".`,
    `Visibilidad confirmada: ${normalizedValue === "public" ? "publico" : "privado"} (private=${privateFlag}).`,
    `No reutilices contextos viejos ni cambies el nombre del repositorio.`,
  ].join(" ");
}

export function resolvePendingContextReply(
  message: string,
  sessionId: string,
  contexts: PendingContextCandidate[]
): PendingResolutionResult {
  const signal = parsePendingSignal(message);
  if (!signal) return { kind: "no_signal" };

  const compatible = contexts
    .filter((ctx) => ctx.session_id === sessionId)
    .filter((ctx) => isActivePayload(ctx.payload))
    .filter((ctx) => isPendingFieldCompatible(ctx.payload, signal))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (compatible.length === 0) {
    return {
      kind: "no_match",
      clarification:
        "No encuentro un flujo activo compatible para esa respuesta. Aclara la accion que quieres continuar.",
    };
  }

  const newestTimestamp = compatible[0].created_at;
  const newestCompatible = compatible.filter((ctx) => ctx.created_at === newestTimestamp);
  if (newestCompatible.length > 1) {
    return {
      kind: "ambiguous",
      clarification:
        "Hay mas de un flujo activo compatible. Indica exactamente que accion quieres continuar.",
    };
  }

  const selected = newestCompatible[0];

  return {
    kind: "resolve_pending_input",
    messageId: selected.message_id,
    payload: selected.payload,
    normalizedValue: signal.value === "public" ? "public" : "private",
    rewrittenMessage: buildVisibilityRewrittenMessage(
      selected.payload,
      signal.value === "public" ? "public" : "private"
    ),
  };
}
