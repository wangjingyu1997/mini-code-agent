import type { ToolCall, ToolDefinition } from "../contracts/tool";

export type UserMessage = Readonly<{
  role: "user";
  content: string;
}>;

export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string;
}>;

export type AssistantToolCallMessage = Readonly<{
  role: "assistant_tool_call";
  callId: string;
  toolName: string;
  input: unknown;
}>;

export type ToolMessage = Readonly<{
  role: "tool";
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}>;

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | AssistantToolCallMessage
  | ToolMessage;

export type ModelRequest = Readonly<{
  sessionId: string;
  turnId: string;
  stepId: string;
  messages: readonly AgentMessage[];
  tools: readonly ToolDefinition[];
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
