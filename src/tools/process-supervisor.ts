import { ProcessController } from "./process-controller";
import { ProcessOutputBuffer } from "./process-output-buffer";

/**
 * Execute a single foreground shell command and await its managed lifetime.
 * Does not permit intentional persistent background sessions.
 */
export type ProcessSupervisorOptions = Readonly<{
  timeoutMs?: number;
  maxOutputBytes?: number;
  postExitIdleMs?: number;
  terminationGraceMs?: number;
}>;

export type ProcessRunRequest = Readonly<{
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}>;

export type ProcessRunResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}>;

export class ProcessSupervisor {
  private readonly options: ProcessSupervisorOptions;

  constructor(options: ProcessSupervisorOptions = {}) {
    // Match the previous public validation contract (including defaults).
    const limits = {
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
      postExitIdleMs: options.postExitIdleMs ?? 100,
      terminationGraceMs: options.terminationGraceMs ?? 1_000,
    };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(name + " must be a positive integer <= 2147483647");
      }
    }
    this.options = limits;
  }

  async run({ command, cwd, env, signal }: ProcessRunRequest): Promise<ProcessRunResult> {
    if (signal.aborted) throw signal.reason ?? new Error("process aborted");

    const buffer = new ProcessOutputBuffer({ maxOutputBytes: this.options.maxOutputBytes });
    let controller!: ProcessController;

    controller = new ProcessController({
      command, cwd, env,
      timeoutMs: this.options.timeoutMs,
      postExitIdleMs: this.options.postExitIdleMs,
      terminationGraceMs: this.options.terminationGraceMs,
      onOutput: (stream, chunk) => {
        if (buffer.append(stream, chunk)) controller.requestStop();
      },
    });

    const onAbort = () => controller.requestStop();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    // A rejected spawn acknowledgement is represented in 'finished.error'.
    // Observe this promise to avoid an unhandled rejection for foreground calls.
    void controller.started.catch(() => {});

    try {
      const outcome = await controller.finished;
      buffer.finish();
      if (outcome.error) throw outcome.error;
      if (signal.aborted) throw signal.reason ?? new Error("process aborted");

      return {
        exitCode: outcome.exitCode,
        signal: outcome.exitSignal,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        ...buffer.capture(),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
