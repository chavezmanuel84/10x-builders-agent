import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@agents/db";
import { executeToolCallAction } from "./tool-call-actions";

const mocks = vi.hoisted(() => ({
  updateToolCallStatusMock: vi.fn(),
  closeActiveContextsByToolCallIdMock: vi.fn(),
  decryptMock: vi.fn(),
  executeGitHubToolMock: vi.fn(),
  executeGoogleCalendarToolMock: vi.fn(),
}));

vi.mock("@agents/db", () => ({
  updateToolCallStatus: mocks.updateToolCallStatusMock,
  closeActiveContextsByToolCallId: mocks.closeActiveContextsByToolCallIdMock,
  decrypt: mocks.decryptMock,
}));

vi.mock("@agents/agent", () => ({
  executeGitHubTool: mocks.executeGitHubToolMock,
  executeGoogleCalendarTool: mocks.executeGoogleCalendarToolMock,
}));

function makeDbClient(options: {
  toolCall?: Record<string, unknown> | null;
  integration?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
}) {
  const makeSingleQuery = (table: string) => {
    const query = {
      eq: () => query,
      single: async () => {
        if (table === "tool_calls") return { data: options.toolCall ?? null };
        if (table === "user_integrations") return { data: options.integration ?? null };
        if (table === "profiles") return { data: options.profile ?? null };
        return { data: null };
      },
    };
    return query;
  };

  return {
    from: (table: string) => ({
      select: () => makeSingleQuery(table),
    }),
  } as unknown as DbClient;
}

describe("executeToolCallAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when pending tool call is not found", async () => {
    const db = makeDbClient({ toolCall: null });
    const result = await executeToolCallAction({
      db,
      toolCallId: "tc-404",
      action: "approve",
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(mocks.updateToolCallStatusMock).not.toHaveBeenCalled();
  });

  it("reject action updates status and closes active contexts", async () => {
    const db = makeDbClient({
      toolCall: {
        id: "tc-1",
        session_id: "session-web",
        tool_name: "github_create_repo",
        arguments_json: { name: "Dummy repo 2", private: false },
        agent_sessions: { user_id: "user-1" },
      },
    });
    const result = await executeToolCallAction({
      db,
      toolCallId: "tc-1",
      action: "reject",
      expectedUserId: "user-1",
    });
    expect(result.ok).toBe(true);
    expect(mocks.updateToolCallStatusMock).toHaveBeenCalledWith(
      db,
      "tc-1",
      "rejected",
      undefined,
      "session-web"
    );
    expect(mocks.closeActiveContextsByToolCallIdMock).toHaveBeenCalledWith(
      db,
      "session-web",
      "tc-1",
      "rejected"
    );
  });

  it("approve without integration marks failed and closes contexts", async () => {
    const db = makeDbClient({
      toolCall: {
        id: "tc-2",
        session_id: "session-web",
        tool_name: "github_create_repo",
        arguments_json: { name: "Dummy repo 2", private: false },
        agent_sessions: { user_id: "user-1" },
      },
      integration: null,
    });
    const result = await executeToolCallAction({
      db,
      toolCallId: "tc-2",
      action: "approve",
      expectedUserId: "user-1",
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(mocks.updateToolCallStatusMock).toHaveBeenCalledWith(
      db,
      "tc-2",
      "failed",
      {
        error: "github not connected",
      },
      "session-web"
    );
    expect(mocks.closeActiveContextsByToolCallIdMock).toHaveBeenCalledWith(
      db,
      "session-web",
      "tc-2",
      "failed"
    );
    expect(mocks.executeGitHubToolMock).not.toHaveBeenCalled();
  });

  it("approve github executes tool and closes contexts as executed", async () => {
    const db = makeDbClient({
      toolCall: {
        id: "tc-3",
        session_id: "session-web",
        tool_name: "github_create_repo",
        arguments_json: { name: "Dummy repo 2", private: false },
        agent_sessions: { user_id: "user-1" },
      },
      integration: { encrypted_tokens: "enc-token" },
    });
    mocks.decryptMock.mockReturnValue("plain-token");
    mocks.executeGitHubToolMock.mockResolvedValue({
      repo_url: "https://github.com/u/dummy-repo-2",
      full_name: "u/dummy-repo-2",
    });

    const result = await executeToolCallAction({
      db,
      toolCallId: "tc-3",
      action: "approve",
      expectedUserId: "user-1",
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ full_name: "u/dummy-repo-2" });
    expect(mocks.updateToolCallStatusMock).toHaveBeenCalledWith(
      db,
      "tc-3",
      "approved",
      undefined,
      "session-web"
    );
    expect(mocks.updateToolCallStatusMock).toHaveBeenCalledWith(
      db,
      "tc-3",
      "executed",
      {
        repo_url: "https://github.com/u/dummy-repo-2",
        full_name: "u/dummy-repo-2",
      },
      "session-web"
    );
    expect(mocks.closeActiveContextsByToolCallIdMock).toHaveBeenCalledWith(
      db,
      "session-web",
      "tc-3",
      "executed"
    );
  });

  it("blocks confirmation when expected session does not match", async () => {
    const db = makeDbClient({
      toolCall: {
        id: "tc-4",
        session_id: "session-old",
        tool_name: "github_create_repo",
        arguments_json: { name: "Dummy repo 2", private: false },
        agent_sessions: { user_id: "user-1" },
      },
    });
    const result = await executeToolCallAction({
      db,
      toolCallId: "tc-4",
      action: "approve",
      expectedUserId: "user-1",
      expectedSessionId: "session-new",
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(mocks.updateToolCallStatusMock).not.toHaveBeenCalled();
  });
});
