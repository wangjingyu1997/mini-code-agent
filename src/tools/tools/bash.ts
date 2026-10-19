import { spawn, type ChildProcess } from "node:child_process";
import type { Tool } from "../tool";
import { conservativeExecutionPlan } from "../resource";

export type BashInput = Readonly<{ command: string }>;

export type BashOutput = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}>;

export type BashApproval = (request: Readonly<{
  command: string;
  cwd: string;
}>) => Promise<boolean>;

export type BashToolOptions = Readonly<{
  approve: BashApproval;
  timeoutMs?: number;
  maxOutputBytes?: number;
}>;

function validate(input: unknown): BashInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("command" in input) ||
    typeof input.command !== "string" ||
    input.command.trim() === ""
  ) {
    throw new TypeError("bash expects { command: string }");
  }
  return { command: input.command };
}

// A shell command may touch any file in the workspace (or beyond it). We
// conservatively serialize it with all workspace tools. This is NOT a sandbox.
function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the immediate child when a process group no longer exists.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

export function createBashTool(options: BashToolOptions): Tool<BashInput, BashOutput> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("maxOutputBytes must be a positive integer");
  }

  return {
    name: "bash",
    description:
      "Run a shell command in the workspace after explicit user approval. " +
      "Returns stdout, stderr and exit code; commands may have side effects.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Complete bash command to run from the workspace root.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    validate,
    plan() {
      return conservativeExecutionPlan;
    },
    async execute(input, context, signal) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("bash aborted");
      }

      // Never run a model-generated command without an affirmative approval.
      const approved = await options.approve({
        command: input.command,
        cwd: context.cwd,
      });
      if (signal.aborted) {
        throw signal.reason ?? new Error("bash aborted");
      }
      if (!approved) {
        throw new Error("User denied bash command");
      }

      const startedAt = Date.now();
      const child = spawn("bash", ["-c", input.command], {
        cwd: context.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      return await new Promise<BashOutput>((resolve, reject) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytesCaptured = 0;
        let timedOut = false;
        let outputTruncated = false;
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const terminate = () => {
          terminateProcessGroup(child, "SIGTERM");
          if (killTimer === undefined) {
            killTimer = setTimeout(() => {
              terminateProcessGroup(child, "SIGKILL");
            }, 1_000);
            killTimer.unref();
          }
        };

        const collect = (chunk: Buffer, target: Buffer[]) => {
          const available = Math.max(0, maxOutputBytes - bytesCaptured);
          if (available > 0) {
            const taken = chunk.subarray(0, available);
            target.push(taken);
            bytesCaptured += taken.length;
          }
          if (chunk.length > available && !outputTruncated) {
            outputTruncated = true;
            terminate();
          }
        };

        const onAbort = () => {
          terminate();
        };

        const timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs);

        const cleanup = () => {
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          signal.removeEventListener("abort", onAbort);
        };

        child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdout));
        child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderr));

        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });

        child.once("close", (exitCode, exitSignal) => {
          if (settled) return;
          settled = true;
          cleanup();

          if (signal.aborted) {
            reject(signal.reason ?? new Error("bash aborted"));
            return;
          }

          resolve({
            exitCode,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut,
            outputTruncated,
            durationMs: Date.now() - startedAt,
          });
        });

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
    serialize(output) {
      return [
        "exit_code: " + (output.exitCode ?? "null"),
        "signal: " + (output.signal ?? "none"),
        "duration_ms: " + output.durationMs,
        "timed_out: " + output.timedOut,
        "output_truncated: " + output.outputTruncated,
        "--- stdout ---",
        output.stdout,
        "--- stderr ---",
        output.stderr,
      ].join("\n");
    },
  };
}
