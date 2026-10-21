import { randomUUID } from "node:crypto";
import { ProcessController, type ProcessExit } from "./process-controller";
import {
  ProcessOutputBuffer,
  type ProcessOutputChunk,
  type ProcessOutputStream,
} from "./process-output-buffer";

export type { ProcessOutputChunk, ProcessOutputStream };
export type ProcessSessionStatus = "running" | "stopping" | "exited" | "failed";

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
  readonly startedAt: number;
  readonly controller: ProcessController;
  readonly output: ProcessOutputBuffer;
  readonly done: Promise<void>;
  status: ProcessSessionStatus;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  error?: string;
};

function positiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError(field + " must be an integer between 1 and 2147483647");
  }
  return value;
}

/**
 * Retains process ownership beyond start() and exposes incremental output.
 * Deliberately not exposed as a model Tool: sessions are not Scheduler claims,
 * and no cross-turn workspace lease or process sandbox is implemented yet.
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

    const output = new ProcessOutputBuffer({
      maxBufferedChunks: this.maxBufferedChunks,
      maxChunkBytes: this.maxChunkBytes,
    });
    const controller = new ProcessController({
      command, cwd, env,
      postExitIdleMs: this.postExitIdleMs,
      terminationGraceMs: this.terminationGraceMs,
      onOutput: (stream, chunk) => { output.append(stream, chunk); },
    });

    const entry: SessionEntry = {
      id: randomUUID(),
      startedAt: Date.now(),
      controller,
      output,
      status: "running",
      exitCode: null,
      exitSignal: null,
      done: controller.finished.then((outcome: ProcessExit) => {
        output.finish();
        entry.exitCode = outcome.exitCode;
        entry.exitSignal = outcome.exitSignal;
        if (outcome.error) {
          entry.status = "failed";
          entry.error = outcome.error.message;
        } else {
          entry.status = "exited";
        }
      }),
    };
    this.sessions.set(entry.id, entry);

    try {
      // spawn success means the shell exists, not that a dev server is ready.
      await controller.started;
    } catch (error) {
      await entry.done;
      this.sessions.delete(entry.id);
      throw error;
    }

    // If closeAll() raced with startup, never return an unmanaged live child.
    if (this.closed) {
      controller.requestStop();
      await entry.done;
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
    const entry = this.entry(id);
    return {
      id,
      ...entry.output.read(fromSequence),
      status: entry.status,
    };
  }

  async terminate(id: string): Promise<ProcessSessionSnapshot> {
    const entry = this.entry(id);
    if (entry.status === "running") entry.status = "stopping";
    entry.controller.requestStop();
    await entry.done;
    return this.snapshot(entry);
  }

  forget(id: string): void {
    const entry = this.entry(id);
    if (entry.status === "running" || entry.status === "stopping") {
      throw new Error("Cannot forget a still running process session");
    }
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    if (this.closed && this.sessions.size === 0) return;
    this.closed = true;
    const entries = [...this.sessions.values()];
    await Promise.all(entries.map(async (entry) => {
      entry.controller.requestStop();
      await entry.done;
    }));
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
      pid: entry.controller.pid,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      exitSignal: entry.exitSignal,
      stopRequested: entry.controller.stopRequested,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }
}
