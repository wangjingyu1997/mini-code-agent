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
      type: "model.started";
      sessionId: string;
      turnId: string;
      stepId: string;
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
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      at: number;
    }>
  | Readonly<{
      type: "tool.completed";
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
      sessionId: string;
      turnId: string;
      stepId: string;
      callId: string;
      toolName: string;
      error: SerializedError;
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
