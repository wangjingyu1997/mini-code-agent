export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
}>;

export type ToolMessage = Readonly<{
  role: "tool";
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}>;

export type AgentMessage = UserMessage | AssistantMessage | ToolMessage;

export type ToolCall = Readonly<{
  id: string;
  name: string;
  input: unknown;
}>;

export type ModelRequest = Readonly<{
  sessionId: string;
  turnId: string;
  stepId: string;
  messages: readonly AgentMessage[];
}>;

export type ModelEvent =
  | Readonly<{
      type: "text.delta";
      text: string;
    }>
  | Readonly<{
      type: "tool.call";
      call: ToolCall;
    }>
  | Readonly<{
      type: "response.completed";
    }>;
