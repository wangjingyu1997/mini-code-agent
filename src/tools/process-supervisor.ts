import { spawn, type ChildProcess } from "node:child_process";

/**
 * Executes ONE foreground shell command. On Unix the shell owns a process
 * group; any remaining members of that group are terminated when the command
 * settles. This is best-effort cleanup, NOT a process-tree sandbox.
 *
 * A descendant which calls setsid()/escapes the group, an external service,
 * or an already-issued side effect is outside this contract.
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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_POST_EXIT_IDLE_MS = 100;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

function positiveInt(value: number, name: string, min: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) {
    throw new RangeError(name + " must be an integer between " + min + " and 2147483647");
  }
  return value;
}

function signalManagedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // detached=true creates a process group led by the shell on Unix.
      // Negative PID sends a signal to the entire group, not just the shell.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      // If the group has already disappeared, do not fall back to signalling
      // a possibly recycled positive PID.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort. The child may already be gone.
  }
}

export class ProcessSupervisor {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly postExitIdleMs: number;
  private readonly terminationGraceMs: number;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.timeoutMs = positiveInt(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1);
    this.maxOutputBytes = positiveInt(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes", 1);
    this.postExitIdleMs = positiveInt(options.postExitIdleMs ?? DEFAULT_POST_EXIT_IDLE_MS, "postExitIdleMs", 1);
    this.terminationGraceMs = positiveInt(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS, "terminationGraceMs", 1);
  }

  async run({ command, cwd, env, signal }: ProcessRunRequest): Promise<ProcessRunResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("process aborted");
    }

    const startedAt = Date.now();
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      env,
    });

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let captured = 0;
      let timedOut = false;
      let outputTruncated = false;
      let settled = false;
      let exitSeen = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let stdoutEnded = child.stdout === null;
      let stderrEnded = child.stderr === null;
      let stopRequested = false;
      let escalationTimer: NodeJS.Timeout | undefined;
      let idleTimer: NodeJS.Timeout | undefined;

      const stop = () => {
        if (stopRequested || settled) return;
        stopRequested = true;
        signalManagedGroup(child, "SIGTERM");
        escalationTimer = setTimeout(() => {
          signalManagedGroup(child, "SIGKILL");
        }, this.terminationGraceMs);
        escalationTimer.unref();
      };

      const onAbort = () => stop();
      const onTimeout = () => { timedOut = true; stop(); };
      const timeoutTimer = setTimeout(onTimeout, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
        if (idleTimer) clearTimeout(idleTimer);
        signal.removeEventListener("abort", onAbort);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
        child.stdout?.removeListener("data", onStdoutData);
        child.stderr?.removeListener("data", onStderrData);
        child.stdout?.removeListener("end", onStdoutEnd);
        child.stderr?.removeListener("end", onStderrEnd);
      };

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;

        // Foreground-command policy: do not leave same-group background writers
        // behind after the shell exits. This also covers the case where SIGTERM
        // kills the shell before the escalation timer fires, but a child survives.
        // It cannot stop descendants which intentionally leave the process group.
        signalManagedGroup(child, "SIGKILL");
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();

        if (error) {
          reject(error);
        } else if (signal.aborted) {
          reject(signal.reason ?? new Error("process aborted"));
        } else {
          resolve({
            exitCode,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut,
            outputTruncated,
            durationMs: Date.now() - startedAt,
          });
        }
      };

      const rearmIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), this.postExitIdleMs);
      };

      const maybeFinish = () => {
        if (exitSeen && stdoutEnded && stderrEnded) finish();
      };

      const onStdoutEnd = () => { stdoutEnded = true; maybeFinish(); };
      const onStderrEnd = () => { stderrEnded = true; maybeFinish(); };
      const onExit = (code: number | null, exitBy: NodeJS.Signals | null) => {
        exitSeen = true;
        exitCode = code;
        exitSignal = exitBy;
        maybeFinish();
        if (!settled) rearmIdle();
      };
      const onClose = (code: number | null, exitBy: NodeJS.Signals | null) => {
        // Node may emit close after the streams close or a spawn error.
        if (!exitSeen) {
          exitCode = code;
          exitSignal = exitBy;
        }
        finish();
      };
      const onError = (error: Error) => finish(error);

      const collect = (chunk: Buffer, target: Buffer[]) => {
        if (settled) return;
        const available = Math.max(0, this.maxOutputBytes - captured);
        if (available > 0) {
          const taken = chunk.subarray(0, available);
          target.push(taken);
          captured += taken.length;
        }
        if (chunk.length > available && !outputTruncated) {
          outputTruncated = true;
          stop();
        }
        // A descendant still writing into inherited stdio after shell exit
        // refreshes our brief idle grace; quiet handles do not block forever.
        if (exitSeen) rearmIdle();
      };
      const onStdoutData = (chunk: Buffer) => collect(chunk, stdout);
      const onStderrData = (chunk: Buffer) => collect(chunk, stderr);

      child.stdout?.on("data", onStdoutData);
      child.stderr?.on("data", onStderrData);
      child.stdout?.once("end", onStdoutEnd);
      child.stderr?.once("end", onStderrEnd);
      child.once("exit", onExit);
      child.once("close", onClose);
      child.once("error", onError);

      signal.addEventListener("abort", onAbort, { once: true });
      // The signal might become aborted between the initial guard and listener
      // registration. Do not leave a spawned shell without a cancel handler.
      if (signal.aborted) onAbort();
    });
  }
}
