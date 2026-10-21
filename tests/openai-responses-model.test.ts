import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponsesModel } from "../src/model/providers/openai-responses-model";
import type { ModelEvent, ModelRequest } from "../src/model/types";

function sseResponse(events: readonly unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

async function collect(model: OpenAIResponsesModel, request: ModelRequest): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of model.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

const baseRequest: ModelRequest = {
  sessionId: "session-1",
  turnId: "turn-1",
  stepId: "step-1",
  messages: [{ role: "user", content: "读取两个文件" }],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
};

test("OpenAI adapter normalizes text and multiple function calls", async () => {
  const fetchImpl: typeof fetch = async () => sseResponse([
    {
      type: "response.output_text.delta",
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      delta: "我先读取文件。",
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "item-a",
        type: "function_call",
        call_id: "call-a",
        name: "read_file",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item-a",
      output_index: 1,
      delta: "{\"pa",
    },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        id: "item-b",
        type: "function_call",
        call_id: "call-b",
        name: "read_file",
        arguments: "",
        status: "in_progress",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item-b",
      output_index: 2,
      delta: "{\"path\":\"b.ts\"}",
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item-b",
      output_index: 2,
      name: "read_file",
      arguments: "{\"path\":\"b.ts\"}",
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "item-a",
      output_index: 1,
      delta: "th\":\"a.ts\"}",
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "item-a",
      output_index: 1,
      name: "read_file",
      arguments: "{\"path\":\"a.ts\"}",
    },
    {
      type: "response.completed",
      response: { id: "resp-1" },
    },
  ]);

  const model = new OpenAIResponsesModel({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });

  const events = await collect(model, baseRequest);

  assert.deepEqual(events, [
    { type: "text.delta", text: "我先读取文件。" },
    {
      type: "tool.call",
      call: {
        id: "call-b",
        name: "read_file",
        input: { path: "b.ts" },
      },
    },
    {
      type: "tool.call",
      call: {
        id: "call-a",
        name: "read_file",
        input: { path: "a.ts" },
      },
    },
    { type: "response.completed" },
  ]);
});

test("OpenAI adapter sends tool schemas and preserves function-call causality", async () => {
  let requestBody: Record<string, unknown> | undefined;

  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        delta: "完成。",
      },
      {
        type: "response.completed",
        response: { id: "resp-2" },
      },
    ]);
  };

  const model = new OpenAIResponsesModel({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });

  await collect(model, {
    ...baseRequest,
    messages: [
      { role: "user", content: "读取 package.json" },
      {
        role: "assistant_tool_call",
        callId: "call-1",
        toolName: "read_file",
        input: { path: "package.json" },
      },
      {
        role: "tool",
        callId: "call-1",
        toolName: "read_file",
        content: "package.json\n---\n{}",
        isError: false,
      },
    ],
  });

  assert.ok(requestBody);
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.stream, true);

  const input = requestBody.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call-1",
    name: "read_file",
    arguments: "{\"path\":\"package.json\"}",
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call-1",
    output: "package.json\n---\n{}",
  });

  const tools = requestBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.name, "read_file");
  assert.equal(tools[0]?.strict, true);
});

test("OpenAI adapter surfaces non-2xx API failures", async () => {
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ error: { message: "rate limited" } }),
    { status: 429, statusText: "Too Many Requests" },
  );

  const model = new OpenAIResponsesModel({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });

  await assert.rejects(
    async () => {
      for await (const _event of model.stream(
        baseRequest,
        new AbortController().signal,
      )) {
        // consume stream
      }
    },
    /429 Too Many Requests/,
  );
});


test("OpenAI adapter reports nested provider error codes rather than opaque Error", async () => {
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context exceeded" } }),
    { status: 400, statusText: "Bad Request" },
  );
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model", fetchImpl,
  });
  await assert.rejects(
    collect(model, baseRequest),
    /400 Bad Request.*context_length_exceeded.*maximum context exceeded/,
  );
});

test("OpenAI adapter rejects response.failed with the actual streaming error", async () => {
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => sseResponse([
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "rate_limit_exceeded", message: "retry later" } },
      },
    ]),
  });
  await assert.rejects(
    collect(model, baseRequest),
    /response.failed.*rate_limit_exceeded.*retry later/,
  );
});

test("OpenAI adapter distinguishes incomplete output from transport termination", async () => {
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => sseResponse([
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ]),
  });
  await assert.rejects(
    collect(model, baseRequest),
    /response.incomplete: max_output_tokens/,
  );
});
