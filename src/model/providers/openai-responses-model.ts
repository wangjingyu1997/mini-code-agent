import type { ToolDefinition } from "../../contracts/tool";
import type { Model } from "../model";
import type { AgentMessage, ModelEvent, ModelRequest } from "../types";
import { parseSseJson } from "../sse";
import { rateLimitWaitMs, waitForRateLimit } from "../rate-limit";
import type { HttpTrace } from "../../observability/raw-trace-recorder";

export type OpenAIResponsesModelOptions = Readonly<{
  apiKey: string;
  model: string;
  baseUrl?: string;
  instructions?: string;
  fetchImpl?: typeof fetch;
  /** Additional HTTP attempts on rate limits, after the initial request. */
  maxRateLimitRetries?: number;
  trace?: HttpTrace;
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

function apiFailureDetail(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 1200);
  const outer = isRecord(payload) ? payload : {};
  const error = isRecord(outer.error) ? outer.error : outer;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string"
    ? error.message
    : typeof outer.message === "string"
      ? outer.message
      : "No provider error details";
  return [code ? `[${code}]` : "", message.slice(0, 1200)].filter(Boolean).join(" ");
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
  private readonly maxRateLimitRetries: number;

  constructor(private readonly options: OpenAIResponsesModelOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("OpenAI API key is required");
    }
    if (!options.model.trim()) {
      throw new Error("OpenAI model is required");
    }

    const maxRetries = options.maxRateLimitRetries ?? 2;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw new RangeError("maxRateLimitRetries must be an integer between 0 and 5");
    }
    this.maxRateLimitRetries = maxRetries;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.instructions = options.instructions ?? [
      "You are a coding agent operating inside a local workspace.",
      "Use the provided tools when you need filesystem evidence.",
      "Do not invent file contents or directory entries.",
      "Keep tool arguments minimal and valid according to their JSON schema.",
      "Use only the exact tool names provided in the tools array; do not invent names or namespace prefixes.",
      "For broad repository searches, prefer a single targeted search using bash (with user approval) over repeatedly listing directories.",
      "For a repository-wide import scan, use search_code with {query, path} before reading files.",
      "Read only relevant files; avoid repeating the same tool call without new evidence.",
      "Use bash only when needed; every shell command requires user approval.",
      "If a command is denied, do not retry it without a new user request.",
      "Never request or reveal API keys, credentials, or .env file contents.",
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

    const requestOptions: RequestInit = {
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
    };

    // Trace only the HTTP JSON payload, never the Authorization header.
    this.options.trace?.record("http.request", {
      url: this.baseUrl + "/responses",
      body: JSON.parse(String(requestOptions.body)) as unknown,
    });

    let response: Response;
    for (let retries = 0; ; retries += 1) {
      if (signal.aborted) throw signal.reason ?? new Error("Model invocation aborted");
      try {
        response = await this.fetchImpl(`${this.baseUrl}/responses`, requestOptions);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
        const networkDetail = cause instanceof Error
          ? cause.message
          : cause && typeof cause === "object" && "code" in cause
            ? String((cause as { code: unknown }).code)
            : undefined;
        this.options.trace?.record("http.network_error", {
          name: error instanceof Error ? error.name : "UnknownError",
          cause: networkDetail ?? "unknown",
        });
        throw new Error("Model network request failed: " +
          (error instanceof Error ? error.message : String(error)) +
          (networkDetail ? " (" + networkDetail + ")" : ""), { cause: error });
      }
      this.options.trace?.record("http.status", { status: response.status, attempt: retries + 1 });
      if (response.ok) break;

      const body = await response.text();
      let payload: unknown = body.slice(0, 1200);
      try { payload = JSON.parse(body) as unknown; } catch { /* provider body may be plain text */ }
      const detail = apiFailureDetail(payload);
      if (response.status !== 429 || retries >= this.maxRateLimitRetries) {
        throw new Error(
          `OpenAI Responses API failed (${response.status} ${response.statusText}): ${detail}` +
          (response.status === 429 && retries > 0
            ? ` (after ${retries} rate-limit retries)`
            : ""),
        );
      }

      // The API rejected this request before SSE streaming began. Retrying
      // cannot duplicate tool calls or partially streamed assistant text.
      const waitMs = rateLimitWaitMs(response, detail, retries);
      yield {
        type: "rate_limit.retry",
        attempt: retries + 1,
        maxRetries: this.maxRateLimitRetries,
        waitMs,
      };
      await waitForRateLimit(waitMs, signal);
    }

    if (!response.body) {
      throw new Error("OpenAI Responses API returned no response body");
    }

    const functionCalls = new Map<string, FunctionCallMetadata>();
    const argumentBuffers = new Map<string, string>();
    let completed = false;

    for await (const rawEvent of parseSseJson(response.body, signal)) {
      this.options.trace?.record("http.sse", rawEvent);
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

        case "response.failed": {
          const responseState = isRecord(rawEvent.response) ? rawEvent.response : rawEvent;
          throw new Error(`Responses API response.failed: ${apiFailureDetail(responseState)}`);
        }

        case "response.incomplete": {
          const responseState = isRecord(rawEvent.response) ? rawEvent.response : {};
          const details = isRecord(responseState.incomplete_details)
            ? responseState.incomplete_details : {};
          const reason = typeof details.reason === "string"
            ? details.reason : "unknown reason";
          throw new Error(`Responses API response.incomplete: ${reason}`);
        }

        case "response.completed": {
          completed = true;
          const responseRecord = isRecord(rawEvent.response) ? rawEvent.response : {};
          const usage = isRecord(responseRecord.usage) ? responseRecord.usage : {};
          const valid = [usage.input_tokens, usage.output_tokens, usage.total_tokens]
            .every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
          yield {
            type: "response.completed",
            ...(valid ? { usage: {
              inputTokens: usage.input_tokens as number,
              outputTokens: usage.output_tokens as number,
              totalTokens: usage.total_tokens as number,
            } } : {}),
          };
          break;
        }

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
