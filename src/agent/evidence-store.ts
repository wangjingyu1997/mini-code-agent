import { createHash } from "node:crypto";
import type { ToolCall } from "../contracts/tool";
import type { ToolExecutionResult } from "../tools/orchestrator";
import { toolRequestKey } from "./tool-key";

export const READ_ONLY_EVIDENCE_TOOLS = new Set(["search_code", "read_file", "list_files"]);
export type EvidenceRecord = Readonly<{
  id: string;
  key: string;
  toolName: string;
  input: unknown;
  content: string;
  digest: string;
  truncated: boolean;
}>;
export type EvidenceObservation = "new" | "unchanged" | "changed" | "ignored";

/**
 * Turn-scoped, bounded in-memory evidence. Deliberately not a disk cache:
 * source may contain sensitive data and external writes can invalidate reads.
 */
export class EvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();
  private nextId = 1;

  constructor(
    private readonly maxEntries = 24,
    private readonly maxContentChars = 10_000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
        !Number.isSafeInteger(maxContentChars) || maxContentChars < 100) {
      throw new RangeError("Invalid EvidenceStore limits");
    }
  }

  observe(call: ToolCall, result: ToolExecutionResult): EvidenceObservation {
    if (!READ_ONLY_EVIDENCE_TOOLS.has(call.name) ||
        result.isError || result.callId !== call.id || result.toolName !== call.name) {
      return "ignored";
    }
    const key = toolRequestKey(call.name, call.input);
    const digest = createHash("sha256").update(result.content).digest("hex");
    const previous = this.records.get(key);
    if (previous?.digest === digest) return "unchanged";

    const truncated = result.content.length > this.maxContentChars;
    const record: EvidenceRecord = {
      id: previous?.id ?? "ev-" + this.nextId++,
      key,
      toolName: call.name,
      input: call.input,
      digest,
      content: truncated
        ? result.content.slice(0, this.maxContentChars) + "\n[evidence snapshot truncated]"
        : result.content,
      truncated,
    };
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > this.maxEntries) {
      this.records.delete(this.records.keys().next().value!);
    }
    return previous ? "changed" : "new";
  }

  invalidate(): void {
    this.records.clear();
  }

  all(): readonly EvidenceRecord[] {
    return [...this.records.values()];
  }

  get count(): number {
    return this.records.size;
  }
}
