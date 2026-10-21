import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type ProcessSessionStatus = "running" | "stopping" | "exited" | "failed";
export type ProcessOutputStream = "stdout" | "stderr";

export type ProcessOutputChunk = Readonly<{
  sequence: number;
  stream: ProcessOutputStream;
  text: string;
}>;

export type ProcessSessionSnapshot = Readonly<{
  id: string;
  status: ProcessSessionStatus;
  pid: number | undefined;
  startedAt: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stopRequested: boolean;
  error?: string;
}>;

export type ProcessSessionRead = Readonly<{
  id: string;
  entries: readonly ProcessOutputChunk[];
  nextSequence: number;
  truncated: boolean;
  status: ProcessSessionStatus;
}>;

export type ProcessSessionManagerOptions = Readonly<{
  maxSessions?: number;
  maxBufferedChunks?: number;
  maxChunkBytes?: number;
  postExitIdleMs?: number;
  terminationGraceMs?: number;
}>;

export type StartProcessSession = Readonly<{
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>;

type SessionEntry = {
  readonly id: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly output: ProcessOutputChunk[];
  readonly done: Promise<void>;
  resolveDone(): void;
  status: ProcessSessionStatus;
  nextSequence: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stopRequested: boolean;
  settled: boolean;
  error?: string;
  escalation?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
};

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(field + " must be an integer between 1 and 2147483647");
  }
  return value;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort; this does not prove process-tree termination.
  }
}

/**
 * Explicit process ownership for long-running commands such as a dev server.
 *
 * A session outlives the call to start(), retaining its process and a bounded
 * stream log until terminate()/natural exit plus forget(), or closeAll().
 *
 * IMPORTANT: This manager is intentionally NOT a model-facing Tool. Its
 * sessions are NOT covered by ToolScheduler's per-Tool resource claims.
 * Run it only under a separate workspace isolation/lease policy.
 */
export class ProcessSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly maxSessions: number;
  private readonly maxBufferedChunks: number;
  private readonly maxChunkBytes: number;
  private readonly postExitIdleMs: number;
  private readonly terminationGraceMs: number;
  private closed = false;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxSessions = positiveInt(options.maxSessions ?? 8, "maxSessions");
    this.maxBufferedChunks = positiveInt(options.maxBufferedChunks ?? 256, "maxBufferedChunks");
    this.maxChunkBytes = positiveInt(options.maxChunkBytes ?? 8192, "maxChunkBytes");
    this.postExitIdleMs = positiveInt(options.postExitIdleMs ?? 100, "postExitIdleMs");
    this.terminationGraceMs = positiveInt(options.terminationGraceMs ?? 1000, "terminationGraceMs");
  }

  async start({ command, cwd, env }: StartProcessSession): Promise<ProcessSessionSnapshot> {
    if (this.closed) throw new Error("ProcessSessionManager is closed");
    if (this.sessions.size >= this.maxSessions) {
      throw new Error("Process session capacity reached; forget terminated sessions");
    }
    if (!command.trim()) throw new TypeError("command must be non-empty");

    const child = spawn("bash", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const entry: SessionEntry = {
      id: randomUUID(),
      child,
      startedAt: Date.now(),
      output: [],
      done,
      resolveDone,
      status: "running",
      nextSequence: 0,
      exitCode: null,
      exitSignal: null,
      stopRequested: false,
      settled: false,
    };
    this.sessions.set(entry.id, entry);

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let exitSeen = false;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const append = (stream: ProcessOutputStream, text: string) => {
      if (!text || entry.settled) return;
      entry.output.push({ sequence: entry.nextSequence++, stream, text });
      if (entry.output.length > this.maxBufferedChunks) entry.output.shift();
    };

    const armIdle = () => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => finish(), this.postExitIdleMs);
    };

    const cleanup = () => {
      if (entry.escalation) clearTimeout(entry.escalation);
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
    };

    const finish = (error?: Error) => {
      if (entry.settled) return;
      entry.settled = true;
      // Foreground-shell ownership: prevent same-group background writers
      // from silently persisting after the shell's main process exits.
      // Escaped process groups and remote side effects remain outside scope.
      signalProcessGroup(child, "SIGKILL");
      if (error) {
        entry.status = "failed";
        entry.error = error.message;
      } else {
        entry.status = "exited";
      }
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      entry.resolveDone();
    };

    const maybeFinish = () => {
      if (exitSeen && stdoutEnded && stderrEnded) finish();
    };

    const consume = (
      stream: ProcessOutputStream,
      chunk: Buffer,
      decoder: StringDecoder,
    ) => {
      if (entry.settled) return;
      // Limit the size of each retained chunk. StringDecoder preserves UTF-8
      // characters across arbitrary stream and chunk boundaries.
      for (let offset = 0; offset < chunk.length; offset += this.maxChunkBytes) {
        const part = chunk.subarray(offset, offset + this.maxChunkBytes);
        append(stream, decoder.write(part));
      }
      if (exitSeen) armIdle();
    };

    const onStdout = (chunk: Buffer) => consume("stdout", chunk, stdoutDecoder);
    const onStderr = (chunk: Buffer) => consume("stderr", chunk, stderrDecoder);
    const onStdoutEnd = () => {
      append("stdout", stdoutDecoder.end());
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      append("stderr", stderrDecoder.end());
      stderrEnded = true;
      maybeFinish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      exitSeen = true;
      entry.exitCode = code;
      entry.exitSignal = signal;
      maybeFinish();
      if (!entry.settled) armIdle();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!exitSeen) {
        entry.exitCode = code;
        entry.exitSignal = signal;
      }
      finish();
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("exit", onExit);
    child.once("close", onClose);

    // Reject the startup operation on spawn errors but make completion of the
    // already-created Entry observable and leave no unusable registry record.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener("error", onStartupError);
          resolve();
        };
        const onStartupError = (error: Error) => {
          child.removeListener("spawn", onSpawn);
          finish(error);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onStartupError);
      });
      // Errors after successful spawn should still settle and retain the
      // failed session for inspection until forget()/closeAll().
      child.once("error", (error: Error) => finish(error));
    } catch (error) {
      this.sessions.delete(entry.id);
      throw error;
    }

    if (this.closed) {
      await this.terminate(entry.id);
      this.sessions.delete(entry.id);
      throw new Error("ProcessSessionManager closed during startup");
    }

    return this.snapshot(entry);
  }

  get(id: string): ProcessSessionSnapshot {
    return this.snapshot(this.entry(id));
  }

  list(): readonly ProcessSessionSnapshot[] {
    return [...this.sessions.values()].map((entry) => this.snapshot(entry));
  }

  read(id: string, fromSequence = 0): ProcessSessionRead {
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 0) {
      throw new RangeError("fromSequence must be a nonnegative integer");
    }
    const entry = this.entry(id);
    const firstRetained = entry.output[0]?.sequence ?? entry.nextSequence;
    return {
      id,
      entries: entry.output.filter((record) => record.sequence >= fromSequence),
      nextSequence: entry.nextSequence,
      truncated: fromSequence < firstRetained,
      status: entry.status,
    };
  }

  async terminate(id: string): Promise<ProcessSessionSnapshot> {
    const entry = this.entry(id);
    if (!entry.settled && !entry.stopRequested) {
      entry.stopRequested = true;
      entry.status = "stopping";
      signalProcessGroup(entry.child, "SIGTERM");
      entry.escalation = setTimeout(() => {
        signalProcessGroup(entry.child, "SIGKILL");
      }, this.terminationGraceMs);
      entry.escalation.unref();
    }
    await entry.done;
    return this.snapshot(entry);
  }

  forget(id: string): void {
    const entry = this.entry(id);
    if (!entry.settled) throw new Error("Cannot forget a still running process session");
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    if (this.closed && this.sessions.size === 0) return;
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.terminate(id)));
    this.sessions.clear();
  }

  private entry(id: string): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error("Unknown process session: " + id);
    return entry;
  }

  private snapshot(entry: SessionEntry): ProcessSessionSnapshot {
    return {
      id: entry.id,
      status: entry.status,
      pid: entry.child.pid,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      stopRequested: entry.stopRequested,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }
}
