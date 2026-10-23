import { createHash } from "node:crypto";
import { toolRequestKey } from "./tool-key";
import type { ToolCall } from "../contracts/tool";
import type { ToolExecutionResult } from "../tools/orchestrator";

const READ_ONLY_TOOLS = new Set(["search_code", "read_file", "list_files"]);


/**
 * Detect a repeated read-only tool loop that gains no new evidence.
 * This is not a cache: the result must actually have been observed.
 * Mutating tools clear observations because a previously read file may change.
 */
export class ToolLoopGuard {
  private readonly evidence = new Map<string, string>();
  private consecutiveRepeats = 0;

  constructor(private readonly maxStaleReads = 2) {
    if (!Number.isInteger(maxStaleReads) || maxStaleReads < 1) {
      throw new RangeError("maxStaleReads must be a positive integer");
    }
  }

  observe(calls: readonly ToolCall[], results: readonly ToolExecutionResult[]): boolean {
    if (calls.some(call => !READ_ONLY_TOOLS.has(call.name))) {
      this.evidence.clear();
      this.consecutiveRepeats = 0;
      return false;
    }
    for (const result of results) {
      const call = calls.find(item => item.id === result.callId);
      if (!call || result.isError) {
        this.consecutiveRepeats = 0;
        continue;
      }
      const key = toolRequestKey(call.name, call.input);
      const digest = createHash("sha256").update(result.content).digest("hex");
      if (this.evidence.get(key) === digest) {
        this.consecutiveRepeats++;
      } else {
        this.consecutiveRepeats = 0;
        this.evidence.set(key, digest);
      }
    }
    return this.consecutiveRepeats >= this.maxStaleReads;
  }
}
