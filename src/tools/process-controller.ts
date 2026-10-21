import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessOutputStream } from "./process-output-buffer";

export type ProcessControllerOptions = Readonly<{
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  postExitIdleMs?: number;
  terminationGraceMs?: number;
  timeoutMs?: number;
  onOutput?: (stream: ProcessOutputStream, chunk: Buffer) => void;
}>;

export type ProcessExit = Readonly<{
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  timedOut: boolean;
  stopRequested: boolean;
  durationMs: number;
  error?: Error;
}>;

function validateDuration(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
    throw new RangeError(name + " must be a positive integer <= 2147483647");
  }
  return value;
}

/** Attempt to signal an entire Unix process group, not merely the shell. */
function signalManagedGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      // A missing group must not trigger a kill of a possibly reused PID.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort, not proof of complete descendant cleanup.
  }
}

/**
 * Owns exactly one foreground Unix process group / Windows shell child.
 *
 * started: spawn has succeeded, NOT application-level readiness.
 * finished: direct child exited (or errored), output streams closed or were
 * cut off after a bounded idle grace, and best-effort group cleanup ran.
 *
 * A descendant that escapes the process group or a remote side effect is
 * outside this contract. This is NOT a process tree reaper or sandbox.
 */
export class ProcessController {
  readonly pid: number | undefined;
  readonly started: Promise<void>;
  readonly finished: Promise<ProcessExit>;

  private readonly child: ChildProcess;
  private readonly startedAt = Date.now();
  private readonly graceMs: number;
  private readonly terminationGraceMs: number;
  private settled = false;
  private stopping = false;
  private exitSeen = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stdoutEnded = false;
  private stderrEnded = false;
  private timedOut = false;
  private executionError?: Error;
  private escalationTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private timeoutTimer?: NodeJS.Timeout;

  constructor(options: ProcessControllerOptions) {
    this.graceMs = validateDuration(options.postExitIdleMs ?? 100, "postExitIdleMs")!;
    this.terminationGraceMs = validateDuration(options.terminationGraceMs ?? 1000, "terminationGraceMs")!;
    validateDuration(options.timeoutMs, "timeoutMs");

    const child = spawn("bash", ["-c", options.command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    this.pid = child.pid;
    this.stdoutEnded = child.stdout === null;
    this.stderrEnded = child.stderr === null;

    let resolveStart!: () => void;
    let rejectStart!: (reason: unknown) => void;
    this.started = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    let resolveFinish!: (outcome: ProcessExit) => void;
    this.finished = new Promise<ProcessExit>((resolve) => {
      resolveFinish = resolve;
    });

    let startSeen = false;
    const onSpawn = () => {
      startSeen = true;
      resolveStart();
    };
    const onError = (error: Error) => {
      if (!startSeen) {
        // There is no running process after a failed spawn.
        rejectStart(error);
        finalize(error);
      } else {
        // Do not release the supervisor's lifetime while a spawned process
        // might still run: request termination and wait for exit/close.
        this.executionError = error;
        this.requestStop();
      }
    };
    const armIdle = () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => finalize(), this.graceMs);
    };
    const maybeFinish = () => {
      if (this.exitSeen && this.stdoutEnded && this.stderrEnded) finalize();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitSeen = true;
      this.exitCode = code;
      this.exitSignal = signal;
      maybeFinish();
      if (!this.settled) armIdle();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.exitSeen) {
        this.exitCode = code;
        this.exitSignal = signal;
      }
      finalize();
    };
    const onStdoutEnd = () => {
      this.stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      this.stderrEnded = true;
      maybeFinish();
    };
    const onStdoutData = (chunk: Buffer) => handleOutput("stdout", chunk);
    const onStderrData = (chunk: Buffer) => handleOutput("stderr", chunk);
    const handleOutput = (stream: ProcessOutputStream, chunk: Buffer) => {
      if (this.settled) return;
      try {
        options.onOutput?.(stream, chunk);
      } catch (error) {
        // A broken output collector must not release Scheduler claims early.
        // Stop the process, but wait for its managed lifecycle to finish.
        this.executionError = error instanceof Error ? error : new Error(String(error));
        this.requestStop();
        return;
      }
      if (this.exitSeen && !this.settled) armIdle();
    };
    const cleanup = () => {
      if (this.escalationTimer) clearTimeout(this.escalationTimer);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdoutData);
      child.stderr?.removeListener("data", onStderrData);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };
    const finalize = (error?: Error) => {
      if (this.settled) return;
      this.settled = true;
      // Foreground policy: no intentional same-group background processes
      // outlive the completion of this controller. This is best effort.
      signalManagedGroup(child, "SIGKILL");
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveFinish({
        exitCode: this.exitCode,
        exitSignal: this.exitSignal,
        timedOut: this.timedOut,
        stopRequested: this.stopping,
        durationMs: Date.now() - this.startedAt,
        ...((error ?? this.executionError) ? { error: (error ?? this.executionError)! } : {}),
      });
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);

    if (options.timeoutMs !== undefined) {
      this.timeoutTimer = setTimeout(() => {
        if (this.settled) return;
        this.timedOut = true;
        this.requestStop();
      }, options.timeoutMs);
    }
  }

  get stopRequested(): boolean {
    return this.stopping;
  }

  requestStop(): void {
    if (this.settled || this.stopping) return;
    this.stopping = true;
    signalManagedGroup(this.child, "SIGTERM");
    this.escalationTimer = setTimeout(
      () => signalManagedGroup(this.child, "SIGKILL"),
      this.terminationGraceMs,
    );
    this.escalationTimer.unref();
  }
}
