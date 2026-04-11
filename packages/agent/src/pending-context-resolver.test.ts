import { describe, expect, it } from "vitest";
import {
  resolvePendingContextReply,
  type PendingContextCandidate,
} from "./pending-context-resolver";

function makeContext(
  overrides: Partial<PendingContextCandidate>
): PendingContextCandidate {
  return {
    message_id: "msg-1",
    session_id: "session-web",
    created_at: "2026-01-01T10:00:00.000Z",
    payload: {
      context_type: "pending_input",
      context_status: "active",
      tool_name: "github_create_repo",
      pending_field: "visibility",
      entity: { repo_name: "Dummy repo 2" },
    },
    ...overrides,
  };
}

describe("resolvePendingContextReply", () => {
  it("continua correctamente repo -> visibilidad -> publico", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        message_id: "msg-current",
        created_at: "2026-01-01T10:02:00.000Z",
      }),
      makeContext({
        message_id: "msg-old-other-tool",
        created_at: "2026-01-01T09:59:00.000Z",
        payload: {
          context_type: "pending_confirmation",
          context_status: "active",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-issue-1",
        },
      }),
    ];

    const result = resolvePendingContextReply("publico", "session-web", contexts);
    expect(result.kind).toBe("resolve_pending_input");
    if (result.kind === "resolve_pending_input") {
      expect(result.messageId).toBe("msg-current");
      expect(result.normalizedValue).toBe("public");
      expect(result.rewrittenMessage).toContain('Repositorio objetivo: "Dummy repo 2"');
      expect(result.rewrittenMessage).toContain("private=false");
    }
  });

  it("no ejecuta accion vieja de otra tool", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        payload: {
          context_type: "pending_confirmation",
          context_status: "active",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-issue-old",
        },
      }),
    ];

    const result = resolvePendingContextReply("publico", "session-web", contexts);
    expect(result.kind).toBe("no_match");
  });

  it("no reutiliza accion vieja del mismo tool pero otra entidad", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        message_id: "msg-old-same-tool",
        payload: {
          context_type: "pending_input",
          context_status: "resolved",
          tool_name: "github_create_repo",
          pending_field: "visibility",
          entity: { repo_name: "Old repo" },
        },
      }),
    ];

    const result = resolvePendingContextReply("publico", "session-web", contexts);
    expect(result.kind).toBe("no_match");
  });

  it("si hay multiples activos compatibles selecciona el mas reciente por created_at", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        message_id: "msg-old",
        created_at: "2026-01-01T09:00:00.000Z",
        payload: {
          context_type: "pending_input",
          context_status: "active",
          tool_name: "github_create_repo",
          pending_field: "visibility",
          entity: { repo_name: "Repo viejo" },
        },
      }),
      makeContext({
        message_id: "msg-new",
        created_at: "2026-01-01T10:00:00.000Z",
        payload: {
          context_type: "pending_input",
          context_status: "active",
          tool_name: "github_create_repo",
          pending_field: "visibility",
          entity: { repo_name: "Repo nuevo" },
        },
      }),
    ];

    const result = resolvePendingContextReply("privado", "session-web", contexts);
    expect(result.kind).toBe("resolve_pending_input");
    if (result.kind === "resolve_pending_input") {
      expect(result.messageId).toBe("msg-new");
      expect(result.normalizedValue).toBe("private");
    }
  });

  it("si persiste ambiguedad no resuelve automaticamente", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        message_id: "msg-a",
        created_at: "2026-01-01T10:00:00.000Z",
      }),
      makeContext({
        message_id: "msg-b",
        created_at: "2026-01-01T10:00:00.000Z",
      }),
    ];

    const result = resolvePendingContextReply("publico", "session-web", contexts);
    expect(result.kind).toBe("ambiguous");
  });

  it("no cruza estado entre web y telegram (session_id)", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        session_id: "session-telegram",
        payload: {
          context_type: "pending_input",
          context_status: "active",
          tool_name: "github_create_repo",
          pending_field: "visibility",
          entity: { repo_name: "Repo telegram" },
        },
      }),
    ];

    const result = resolvePendingContextReply("publico", "session-web", contexts);
    expect(result.kind).toBe("no_match");
  });

  it("respuesta ambigua en sesion nueva no ejecuta pending_confirmation viejo", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        session_id: "session-old",
        payload: {
          context_type: "pending_confirmation",
          context_status: "active",
          tool_name: "github_create_repo",
          pending_field: "confirmation",
          tool_call_id: "tc-old",
        },
      }),
    ];

    const result = resolvePendingContextReply("si", "session-new", contexts);
    expect(result.kind).toBe("no_match");
  });

  it("contextos cerrados no se seleccionan (approved/rejected/executed/failed)", () => {
    const contexts: PendingContextCandidate[] = [
      makeContext({
        payload: {
          context_type: "pending_confirmation",
          context_status: "approved",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-approved",
        },
      }),
      makeContext({
        payload: {
          context_type: "pending_confirmation",
          context_status: "rejected",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-rejected",
        },
      }),
      makeContext({
        payload: {
          context_type: "pending_confirmation",
          context_status: "executed",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-executed",
        },
      }),
      makeContext({
        payload: {
          context_type: "pending_confirmation",
          context_status: "failed",
          tool_name: "github_create_issue",
          pending_field: "confirmation",
          tool_call_id: "tc-failed",
        },
      }),
    ];

    const result = resolvePendingContextReply("si", "session-web", contexts);
    expect(result.kind).toBe("no_match");
  });
});
