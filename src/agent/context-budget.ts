import type { AgentMessage } from "../model/types";

export type ContextBudgetOptions = Readonly<{
  /** Approximate input-token ceiling, not a provider tokenizer or TPM quota. */
  maxEstimatedTokens?: number;
  /** Maximum UTF-8 characters sent in each individual Tool result. */
  maxToolOutputChars?: number;
}>;

export type ContextBuild = Readonly<{
  messages: readonly AgentMessage[];
  estimatedTokens: number;
  originalEstimatedTokens: number;
  droppedMessages: number;
  compacted: boolean;
}>;

const DEFAULT_TOKENS = 3_000;
const DEFAULT_TOOL_CHARS = 5_000;

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 100) {
    throw new RangeError(label + " must be an integer >= 100");
  }
  return value;
}

export function estimateTokens(value: unknown): number {
  // Heuristic only. UTF-8 byte length / 3 is a conservative approximation for
  // mixed English/CJK content; it is NOT an exact BPE model token count.
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
}

export function boundToolOutput(content: string, maxChars = DEFAULT_TOOL_CHARS): string {
  positive(maxChars, "maxToolOutputChars");
  if (content.length <= maxChars) return content;
  // Don't drop the fact that a Tool output was abbreviated. We retain the
  // beginning so read_file's path/hash remain recognizable, but the rest is
  // explicitly unavailable to the model.
  const marker = "\n… [tool output truncated; request a narrower read/search]\n";
  return content.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

type Unit = { messages: AgentMessage[]; size: number };

/** Group complete function_call / function_call_output batches, never split them. */
function contextUnits(history: readonly AgentMessage[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < history.length;) {
    const start = history[i]!;
    if (start.role !== "assistant_tool_call") {
      units.push({ messages: [start], size: estimateTokens([start]) });
      i++;
      continue;
    }
    const calls: AgentMessage[] = [];
    const outputs: AgentMessage[] = [];
    while (history[i]?.role === "assistant_tool_call") calls.push(history[i++]!);
    while (history[i]?.role === "tool") outputs.push(history[i++]!);

    const ids = new Set(calls.map((c) => c.role === "assistant_tool_call" ? c.callId : ""));
    const outputIds = new Set(outputs.map((m) => m.role === "tool" ? m.callId : ""));
    if (ids.size === calls.length && outputs.length === calls.length &&
        ids.size === outputIds.size &&
        [...ids].every((id) => outputIds.has(id))) {
      const messages = [...calls, ...outputs];
      units.push({ messages, size: estimateTokens(messages) });
    } else {
      // Incomplete/malformed calls are not safe to replay. Do not manufacture
      // function-call output or forward dangling tool responses.
      units.push({ messages: [], size: 0 });
    }
  }
  return units;
}

/**
 * Deterministic, lossy context compaction at the *request* boundary.
 * Session.history stays untouched for diagnostics/recovery. Completed
 * function_call + function_call_output batches are retained/dropped together.
 * Always preserve the most recent user request. Older history is summarized
 * only as counts, never an invented LLM summary of unseen source code.
 */
export function buildContext(
  history: readonly AgentMessage[],
  options: ContextBudgetOptions = {},
  toolDefinitions: readonly unknown[] = [],
): ContextBuild {
  const maxTokens = positive(options.maxEstimatedTokens ?? DEFAULT_TOKENS, "maxEstimatedTokens");
  const originalEstimatedTokens = estimateTokens({ history, toolDefinitions });
  const overhead = estimateTokens(toolDefinitions) + 120; // instructions/protocol reserve (approx.)
  const budget = Math.max(100, maxTokens - overhead);

  const capped = history.map((m): AgentMessage =>
    m.role === "tool"
      ? { ...m, content: boundToolOutput(m.content, options.maxToolOutputChars ?? DEFAULT_TOOL_CHARS) }
      : m,
  );
  const units = contextUnits(capped);
  let latestUserIndex = -1;
  for (let i = capped.length - 1; i >= 0; i--) {
    if (capped[i]?.role === "user") { latestUserIndex = i; break; }
  }
  const selected = new Set<number>();
  let used = 0;

  // Preserve the active user intent even when it exceeds the configured
  // budget (caller receives an estimate showing the oversize).
  let offset = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    const end = offset + unit.messages.length;
    if (latestUserIndex >= offset && latestUserIndex < end) {
      selected.add(i);
      used += unit.size;
      break;
    }
    offset = end;
  }

  // Critical invariant: never discard the most recent completed tool result
  // merely because one read_file response exceeds the remaining budget.
  // Keep its function-call pair and shrink the output until that pair fits.
  const newestIndex = units.length - 1;
  let recentEvidenceTrimmed = false;
  const newest = units[newestIndex];
  if (newest && !selected.has(newestIndex) &&
      newest.messages.some((message) => message.role === "tool")) {
    const maxChars = Math.max(0, ...newest.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.role === "tool" ? message.content.length : 0));

    const resize = (limit: number): AgentMessage[] => newest.messages.map((message) => {
      if (message.role !== "tool" || message.content.length <= limit) return message;
      return { ...message, content: message.content.slice(0, limit) +
        "\\n[tool evidence shortened to fit current model request]" };
    });
    const room = Math.max(0, budget - used - 60);
    let low = 0;
    let high = maxChars;
    let fitting: AgentMessage[] | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = resize(mid);
      if (estimateTokens(candidate) <= room) {
        fitting = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (fitting) {
      const trimmed = newest.messages.some((message, index) =>
        message.role === "tool" && fitting![index]?.role === "tool" &&
        (fitting![index] as { content: string }).content !== message.content);
      recentEvidenceTrimmed = trimmed;
      units[newestIndex] = { messages: fitting, size: estimateTokens(fitting) };
      selected.add(newestIndex);
      used += estimateTokens(fitting);
    }
  }

  // Only add a contiguous suffix of complete batches: older context isn't
  // more important than the latest tool evidence. Avoid dropping a new tool
  // output while keeping its preceding function_call, or vice versa.
  for (let i = units.length - 1; i >= 0; i--) {
    if (selected.has(i)) continue;
    const unit = units[i]!;
    if (unit.messages.length === 0) continue;
    if (used + unit.size > budget) break;
    selected.add(i);
    used += unit.size;
  }

  const picked: AgentMessage[] = [];
  let dropped = 0;
  units.forEach((unit, index) => {
    if (selected.has(index)) picked.push(...unit.messages);
    else dropped += unit.messages.length;
  });
  const shortened = history.some((m, i) => m.role === "tool" &&
    capped[i]?.role === "tool" && (capped[i] as { content: string }).content.length < m.content.length);
  const compacted = dropped > 0 || shortened || recentEvidenceTrimmed;

  if (dropped > 0) {
    picked.unshift({
      role: "user",
      content: "[Context notice: older conversation/tool results omitted to stay within the configured input budget. Do not assume their contents. If needed, inspect the relevant files again. " +
        dropped + " messages omitted.]",
    });
  }

  return {
    messages: picked,
    estimatedTokens: estimateTokens({ messages: picked, toolDefinitions }) + 120,
    originalEstimatedTokens,
    droppedMessages: dropped,
    compacted,
  };
}
