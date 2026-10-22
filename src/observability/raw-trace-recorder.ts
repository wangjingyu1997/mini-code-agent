import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../events/event";

/**
 * Opt-in raw JSONL trace. It can include prompts, source code, tool arguments,
 * model output, file contents and secrets. NEVER enable by default or send
 * this file to a public issue tracker. File permissions 0600 are best effort.
 */
export class RawTraceRecorder {
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(readonly filePath: string) {}

  record(type: string, data: unknown): void {
    if (this.failure) return;
    const line = JSON.stringify({ timestamp: Date.now(), type, data }) + "\n";
    this.pending = this.pending.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, line, { mode: 0o600, encoding: "utf8" });
    }).catch((error: unknown) => { this.failure = error; });
  }

  recordEvent(event: AgentEvent): void {
    // Contains raw unredacted inputs/outputs. This is intentional ONLY when
    // AGENT_TRACE=1 is set by the operator.
    this.record("agent." + event.type, event);
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }
}

export type HttpTrace = Pick<RawTraceRecorder, "record">;
