import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "./event";

// Persist only an explicit metadata allowlist. NEVER serialize AgentEvent
// directly: user prompts, tool arguments, source files and stderr may contain
// credentials or private data.
export type SafeEventLogRecord = Readonly<Record<string, string | number | boolean>>;

function safeName(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : "[redacted]";
}

export function toSafeEventLogRecord(event: AgentEvent): SafeEventLogRecord | null {
  // Token-level streaming events are intentionally not persisted.
  if (event.type === "model.text.delta") return null;

  const record: Record<string, string | number | boolean> = {
    version: 1,
    type: event.type,
    at: event.at,
    sessionId: event.sessionId,
    turnId: event.turnId,
  };

  if ("stepId" in event) record.stepId = event.stepId;
  if ("callId" in event) record.callId = event.callId;
  if ("toolName" in event) record.toolName = safeName(event.toolName);

  switch (event.type) {
    case "turn.started":
      record.inputChars = event.input.length;
      break;
    case "turn.completed":
      record.answerChars = event.answer.length;
      break;
    case "turn.aborted":
      record.status = "aborted";
      break;
    case "turn.failed":
    case "model.failed":
      record.errorType = safeName(event.error.name);
      if (event.type === "model.failed") record.durationMs = event.durationMs;
      break;
    case "model.rate_limited":
      record.retryAttempt = event.attempt;
      record.waitMs = event.waitMs;
      break;
    case "model.completed":
      record.durationMs = event.durationMs;
      record.textChars = event.textChars;
      record.toolCallCount = event.toolCallCount;
      break;
    case "tool.started":
      record.queueWaitMs = event.queueWaitMs;
      if (event.queueReason) record.queueReason = event.queueReason;
      break;
    case "tool.completed":
      record.durationMs = event.durationMs;
      record.outputChars = event.output.length;
      break;
    case "tool.failed":
      record.durationMs = event.durationMs;
      record.errorType = safeName(event.error.name);
      break;
    case "model.started":
    case "tool.requested":
      break;
  }

  return record;
}

export class JsonlEventRecorder {
  private pending: Promise<void> = Promise.resolve();
  private writeError: unknown;

  constructor(private readonly filePath: string) {}

  record(event: AgentEvent): void {
    const safeRecord = toSafeEventLogRecord(event);
    if (!safeRecord || this.writeError !== undefined) return;

    const line = JSON.stringify(safeRecord) + "\n";
    // Serialize file writes without delaying EventBus subscribers or the
    // model stream. flush() at shutdown waits for outstanding writes.
    this.pending = this.pending.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    }).catch((error: unknown) => {
      this.writeError = error;
    });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.writeError !== undefined) {
      throw this.writeError;
    }
  }
}
