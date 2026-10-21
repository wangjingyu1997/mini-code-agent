import { ProcessSupervisor, type ProcessRunResult } from "../process-supervisor";
import type { Tool } from "../tool";
import { conservativeExecutionPlan } from "../resource";

export type BashInput = Readonly<{ command: string }>;

export type BashOutput = ProcessRunResult;

export type BashApproval = (request: Readonly<{
  command: string;
  cwd: string;
}>, signal: AbortSignal) => Promise<boolean>;

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

// A shell command may touch files outside the workspace. This is not a sandbox.
function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY)/i.test(name)) {
      delete env[name];
    }
  }
  return env;
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
  const supervisor = new ProcessSupervisor({ timeoutMs, maxOutputBytes });

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
      }, signal);
      if (signal.aborted) {
        throw signal.reason ?? new Error("bash aborted");
      }
      if (!approved) {
        throw new Error("User denied bash command");
      }

      return supervisor.run({
        command: input.command,
        cwd: context.cwd,
        env: sanitizedChildEnvironment(),
        signal,
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
