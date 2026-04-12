import { describe, expect, it } from "vitest";
import { runBashCommandOnce } from "./bash-exec";

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
});
