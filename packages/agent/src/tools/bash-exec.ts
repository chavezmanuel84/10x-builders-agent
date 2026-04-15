import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_STREAM_BYTES = 1024 * 1024;

// Evaluated once at module load. Falls back to process.cwd() only when
// AGENT_WORKSPACE_ROOT is not set (local dev without configuration).
const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT?.trim() || process.cwd();

/**
 * Validates AGENT_WORKSPACE_ROOT at server startup.
 * Call this once during application boot so a misconfigured env var fails fast
 * rather than silently falling back to an unexpected directory at runtime.
 */
export async function validateWorkspaceRoot(): Promise<void> {
  const raw = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (!raw) return;
  const stat = await fs.stat(raw).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`AGENT_WORKSPACE_ROOT is not an accessible directory: ${raw}`);
  }
}

export interface RunBashInput {
  prompt: string;
  cwd?: string;
  terminal?: string;
  timeoutMs?: number;
  maxStreamBytes?: number;
}

export interface RunBashResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated?: boolean;
  terminal?: string;
}

function collectStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;

    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      if (total >= maxBytes) {
        truncated = true;
        return;
      }
      const next = total + buf.length;
      if (next <= maxBytes) {
        chunks.push(buf);
        total = next;
      } else {
        chunks.push(buf.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
    });
  });
}

async function resolveWorkingDirectory(cwd: string | undefined): Promise<string> {
  if (cwd === undefined || cwd === null || String(cwd).trim() === "") {
    return WORKSPACE_ROOT;
  }
  // Resolve relative paths against WORKSPACE_ROOT so "src" becomes
  // "/workspace/src" rather than an accident of the server's launch directory.
  const resolved = path.resolve(WORKSPACE_ROOT, String(cwd).trim());
  // Containment check: reject any path that escapes the workspace root.
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(
      `cwd escapes workspace root — only paths inside '${WORKSPACE_ROOT}' are allowed: ${cwd}`
    );
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) {
    throw new Error(`cwd does not exist or is not accessible: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  return resolved;
}

/**
 * Runs a single bash command via `bash -lc` on the current host.
 * Throws on invalid input, missing cwd, spawn errors, or timeout.
 */
export async function runBashCommandOnce(input: RunBashInput): Promise<RunBashResult> {
  const command = String(input.prompt ?? "").trim();
  if (!command) {
    throw new Error("bash: empty command (prompt)");
  }

  const workingDir = await resolveWorkingDirectory(input.cwd);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutP = child.stdout
      ? collectStream(child.stdout, maxBytes)
      : Promise.resolve({ text: "", truncated: false });
    const stderrP = child.stderr
      ? collectStream(child.stderr, maxBytes)
      : Promise.resolve({ text: "", truncated: false });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        } catch {
          /* ignore */
        }
      }, 2000).unref?.();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, _signal) => {
      clearTimeout(timeoutId);
      void Promise.all([stdoutP, stderrP])
        .then(([out, errOut]) => {
          if (timedOut) {
            reject(new Error(`bash command timed out after ${timeoutMs}ms`));
            return;
          }
          const truncated = out.truncated || errOut.truncated;
          const result: RunBashResult = {
            stdout: out.text,
            stderr: errOut.text,
            exit_code: code === null || code === undefined ? 1 : code,
            ...(truncated ? { truncated: true } : {}),
            ...(input.terminal !== undefined && input.terminal !== ""
              ? { terminal: input.terminal }
              : {}),
          };
          resolve(result);
        })
        .catch(reject);
    });
  });
}
