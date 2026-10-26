export type SerializedError = Readonly<{
  name: string;
  message: string;
  stack?: string;
}>;

export type AgentEvent =
  | Readonly<{
      type: "turn.started";
      sessionId: string;
      turnId: string;
      input: string;
      at: number;
    }>
  | Readonly<{
      type: "model.request.prepared";
      sessionId: string;
      turnId: string;
      stepId: string;
      messageCount: number;
      toolCount: number;
      estimatedTokens: number;
      originalEstimatedTokens: number;
      droppedMessages: number;
      compacted: boolean;
      at: number;
    }>
  | Readonly<{
      type: "task.progress.updated";
      sessionId: string;
      turnId: string;
      stepId: string;
      distinctEvidence: number;
      repeatedReads: number;
      changedReads: number;
      invalidations: number;
      at: number;
    }>
  | Readonly<{
      type: "tool.output.budgeted";
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      originalChars: number;
      forwardedChars: number;
      at: number;
    }>
  | Readonly<{
      type: "model.started";
      sessionId: string;
      turnId: string;
      stepId: string;
      at: number;
    }>
  | Readonly<{
      type: "model.rate_limited";
      sessionId: string;
      turnId: string;
      stepId: string;
      attempt: number;
      maxRetries: number;
      waitMs: number;
      at: number;
    }>
  | Readonly<{
      type: "model.completed";
      sessionId: string;
      turnId: string;
      stepId: string;
      durationMs: number;
      toolCallCount: number;
      textChars: number;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
      at: number;
    }>
  | Readonly<{
      type: "model.failed";
      sessionId: string;
      turnId: string;
      stepId: string;
      durationMs: number;
      error: SerializedError;
      at: number;
    }>
  | Readonly<{
      type: "model.text.delta";
      sessionId: string;
      turnId: string;
      stepId: string;
      delta: string;
      at: number;
    }>
  | Readonly<{
      type: "tool.requested";
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      input: unknown;
      at: number;
    }>
  | Readonly<{
      type: "tool.started";
      queueWaitMs: number;
      queueReason?: "concurrency_limit" | "resource_conflict" | "fifo_fairness";
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      at: number;
    }>
  | Readonly<{
      type: "tool.completed";
      durationMs: number;
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      output: string;
      at: number;
    }>
  | Readonly<{
      type: "tool.failed";
      durationMs: number;
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      error: SerializedError;
      at: number;
    }>
  | Readonly<{
      type: "turn.recovery_requested";
      sessionId: string;
      turnId: string;
      stepId: string;
      attempt: number;
      at: number;
    }>
  | Readonly<{
      type: "turn.loop_detected";
      sessionId: string;
      turnId: string;
      stepId: string;
      at: number;
    }>
  | Readonly<{
      type: "turn.max_steps";
      sessionId: string;
      turnId: string;
      steps: number;
      at: number;
    }>
  | Readonly<{
      type: "turn.completed";
      sessionId: string;
      turnId: string;
      answer: string;
      at: number;
    }>
  | Readonly<{
      type: "turn.aborted";
      sessionId: string;
      turnId: string;
      reason: string;
      at: number;
    }>
  | Readonly<{
      type: "turn.failed";
      sessionId: string;
      turnId: string;
      error: SerializedError;
      at: number;
    }>;

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const result: SerializedError = {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
    return result;
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
