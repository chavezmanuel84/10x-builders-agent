import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { runBashCommandOnce, validateWorkspaceRoot } from "./bash-exec";

describe("runBashCommandOnce", () => {
  it("throws on empty prompt", async () => {
    await expect(runBashCommandOnce({ prompt: "   " })).rejects.toThrow(/empty command/i);
  });

  it("throws on invalid cwd", async () => {
    await expect(
      runBashCommandOnce({
        prompt: "echo hi",
        cwd: "/nonexistent-path-xyz-12345",
      })
    ).rejects.toThrow(/cwd does not exist/i);
  });

  it("throws when cwd is not a directory", async () => {
    await expect(
      runBashCommandOnce({
        prompt: "echo hi",
        cwd: new URL(import.meta.url).pathname,
      })
    ).rejects.toThrow(/not a directory/i);
  });

  it("runs a command successfully", async () => {
    const r = await runBashCommandOnce({
      prompt: `node -e "console.log('hello')"`,
    });
    expect(r.exit_code).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
    expect(r.stderr).toBe("");
  });

  it("includes terminal in result when provided", async () => {
    const r = await runBashCommandOnce({
      prompt: `node -e "console.log(1)"`,
      terminal: "corr-1",
    });
    expect(r.terminal).toBe("corr-1");
  });

  it("times out", async () => {
    await expect(
      runBashCommandOnce({
        prompt: "sleep 60",
        timeoutMs: 250,
      })
    ).rejects.toThrow(/timed out/i);
  }, 15_000);

  it("marks truncated when stdout exceeds cap", async () => {
    const r = await runBashCommandOnce({
      prompt: `node -e "process.stdout.write('x'.repeat(5000))"`,
      maxStreamBytes: 200,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(200);
    expect(r.exit_code).toBe(0);
  });

  it("empty cwd falls back to WORKSPACE_ROOT (not arbitrary process.cwd)", async () => {
    const r = await runBashCommandOnce({ prompt: "pwd", cwd: "" });
    expect(r.exit_code).toBe(0);
    // The result must be a real absolute path — not empty or undefined.
    expect(r.stdout.trim()).toMatch(/^\//);
    // Crucially it must equal the module-level WORKSPACE_ROOT, which is
    // process.env.AGENT_WORKSPACE_ROOT if set, or process.cwd() as fallback.
    const expectedRoot = process.env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd();
    expect(r.stdout.trim()).toBe(expectedRoot);
  });

  it("relative cwd is resolved against WORKSPACE_ROOT, not server launch dir", async () => {
    const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd();
    // Create a real sub-directory inside workspaceRoot to use as relative cwd.
    const subDir = await fs.mkdtemp(nodePath.join(workspaceRoot, "bash-test-"));
    try {
      const r = await runBashCommandOnce({ prompt: "pwd", cwd: nodePath.relative(workspaceRoot, subDir) });
      expect(r.exit_code).toBe(0);
      expect(r.stdout.trim()).toBe(subDir);
    } finally {
      await fs.rmdir(subDir);
    }
  });

  it("throws when cwd escapes workspace root via path traversal", async () => {
    // "../../etc" traverses upward from WORKSPACE_ROOT — must be rejected.
    await expect(
      runBashCommandOnce({ prompt: "pwd", cwd: "../../etc" })
    ).rejects.toThrow(/escapes workspace root/i);
  });

  it("throws when cwd is an absolute path outside workspace root", async () => {
    const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd();
    // Only run this assertion when /tmp is genuinely outside the workspace root.
    const tmpDir = os.tmpdir();
    if (!tmpDir.startsWith(workspaceRoot)) {
      await expect(
        runBashCommandOnce({ prompt: "pwd", cwd: tmpDir })
      ).rejects.toThrow(/escapes workspace root/i);
    }
  });
});

describe("validateWorkspaceRoot", () => {
  it("resolves without error when AGENT_WORKSPACE_ROOT is not set", async () => {
    const original = process.env.AGENT_WORKSPACE_ROOT;
    delete process.env.AGENT_WORKSPACE_ROOT;
    try {
      await expect(validateWorkspaceRoot()).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) process.env.AGENT_WORKSPACE_ROOT = original;
    }
  });

  it("resolves without error when AGENT_WORKSPACE_ROOT is a valid directory", async () => {
    const original = process.env.AGENT_WORKSPACE_ROOT;
    process.env.AGENT_WORKSPACE_ROOT = os.tmpdir();
    try {
      await expect(validateWorkspaceRoot()).resolves.toBeUndefined();
    } finally {
      if (original !== undefined) process.env.AGENT_WORKSPACE_ROOT = original;
      else delete process.env.AGENT_WORKSPACE_ROOT;
    }
  });

  it("throws when AGENT_WORKSPACE_ROOT points to a nonexistent path", async () => {
    const original = process.env.AGENT_WORKSPACE_ROOT;
    process.env.AGENT_WORKSPACE_ROOT = "/nonexistent-workspace-root-xyz";
    try {
      await expect(validateWorkspaceRoot()).rejects.toThrow(/AGENT_WORKSPACE_ROOT is not an accessible directory/i);
    } finally {
      if (original !== undefined) process.env.AGENT_WORKSPACE_ROOT = original;
      else delete process.env.AGENT_WORKSPACE_ROOT;
    }
  });
});
