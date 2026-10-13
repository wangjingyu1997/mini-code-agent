import type { ToolDefinition } from "../../contracts/tool";
import type { Model } from "../model";
import type { AgentMessage, ModelEvent, ModelRequest } from "../types";
import { parseSseJson } from "../sse";

export type OpenAIResponsesModelOptions = Readonly<{
  apiKey: string;
  model: string;
  baseUrl?: string;
  instructions?: string;
  fetchImpl?: typeof fetch;
}>;

type FunctionCallMetadata = {
  callId: string;
  name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toOpenAIInput(messages: readonly AgentMessage[]): readonly Record<string, unknown>[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
      case "assistant":
        return {
          role: message.role,
          content: message.content,
        };

      case "assistant_tool_call":
        return {
          type: "function_call",
          call_id: message.callId,
          name: message.toolName,
          arguments: JSON.stringify(message.input),
        };

      case "tool":
        return {
          type: "function_call_output",
          call_id: message.callId,
          output: message.isError
            ? `[tool_error] ${message.content}`
            : message.content,
        };
    }
  });
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  };
}

function parseArguments(raw: string, toolName: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI returned invalid JSON arguments for ${toolName}: ${detail}`);
  }
}

export class OpenAIResponsesModel implements Model {
  private readonly baseUrl: string;
  private readonly instructions: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIResponsesModelOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OpenAI API key is required");
    }
    if (!options.model.trim()) {
      throw new Error("OpenAI model is required");
    }

    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.instructions = options.instructions ?? [
      "You are a coding agent operating inside a local workspace.",
      "Use the provided tools when you need filesystem evidence.",
      "Do not invent file contents or directory entries.",
      "Keep tool arguments minimal and valid according to their JSON schema.",
    ].join(" ");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Model invocation aborted");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        instructions: this.instructions,
        input: toOpenAIInput(request.messages),
        tools: request.tools.map(toOpenAITool),
        tool_choice: "auto",
        stream: true,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI Responses API failed (${response.status} ${response.statusText}): ${body}`,
      );
    }

    if (!response.body) {
      throw new Error("OpenAI Responses API returned no response body");
    }

    const functionCalls = new Map<string, FunctionCallMetadata>();
    const argumentBuffers = new Map<string, string>();
    let completed = false;

    for await (const rawEvent of parseSseJson(response.body, signal)) {
      if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") {
        continue;
      }

      switch (rawEvent.type) {
        case "response.output_item.added": {
          const item = rawEvent.item;
          if (
            isRecord(item) &&
            item.type === "function_call" &&
            typeof item.id === "string" &&
            typeof item.call_id === "string" &&
            typeof item.name === "string"
          ) {
            functionCalls.set(item.id, {
              callId: item.call_id,
              name: item.name,
            });
            argumentBuffers.set(item.id, "");
          }
          break;
        }

        case "response.output_text.delta": {
          if (typeof rawEvent.delta === "string") {
            yield {
              type: "text.delta",
              text: rawEvent.delta,
            };
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          if (
            typeof rawEvent.item_id === "string" &&
            typeof rawEvent.delta === "string"
          ) {
            const previous = argumentBuffers.get(rawEvent.item_id) ?? "";
            argumentBuffers.set(rawEvent.item_id, previous + rawEvent.delta);
          }
          break;
        }

        case "response.function_call_arguments.done": {
          if (typeof rawEvent.item_id !== "string") {
            throw new Error("Malformed response.function_call_arguments.done event");
          }

          const bufferedArguments = argumentBuffers.get(rawEvent.item_id) ?? "";
          const finalArguments = typeof rawEvent.arguments === "string"
            ? rawEvent.arguments
            : bufferedArguments;

          if (!finalArguments) {
            throw new Error("Function call completed without arguments");
          }

          const metadata = functionCalls.get(rawEvent.item_id);
          const eventName = typeof rawEvent.name === "string" ? rawEvent.name : undefined;
          const eventCallId = typeof rawEvent.call_id === "string"
            ? rawEvent.call_id
            : undefined;
          const name = metadata?.name ?? eventName;
          const callId = metadata?.callId ?? eventCallId;

          if (!name || !callId) {
            throw new Error(
              `Missing function-call metadata for OpenAI item ${rawEvent.item_id}`,
            );
          }

          yield {
            type: "tool.call",
            call: {
              id: callId,
              name,
              input: parseArguments(finalArguments, name),
            },
          };
          break;
        }

        case "response.completed":
          completed = true;
          yield { type: "response.completed" };
          break;

        case "error": {
          const message = typeof rawEvent.message === "string"
            ? rawEvent.message
            : "Unknown OpenAI streaming error";
          throw new Error(`OpenAI stream error: ${message}`);
        }
      }
    }

    if (!completed && !signal.aborted) {
      throw new Error("OpenAI stream ended before response.completed");
    }
  }
}
