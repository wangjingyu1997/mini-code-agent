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
    maxRateLimitRetries: 0,
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


test("HTTP 429 retries an unchanged request once and continues without duplicate tools", async () => {
  const bodies: string[] = [];
  let attempts = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    attempts++;
    if (attempts === 1) {
      return new Response(
        JSON.stringify({ error: { code: "rate_limit_exceeded", message: "TPM exceeded" } }),
        { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "0" } },
      );
    }
    return sseResponse([
      { type: "response.output_text.delta", delta: "Done." },
      { type: "response.completed" },
    ]);
  };
  const model = new OpenAIResponsesModel({ apiKey: "test-key", model: "test-model", fetchImpl });
  const events = await collect(model, baseRequest);
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1], "a 429 cannot mutate tool causality or message history");
  assert.deepEqual(events, [
    { type: "rate_limit.retry", attempt: 1, maxRetries: 2, waitMs: 0 },
    { type: "text.delta", text: "Done." },
    { type: "response.completed" },
  ]);
});

test("HTTP 429 repeated beyond retry budget fails without an unbounded loop", async () => {
  let attempts = 0;
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model", maxRateLimitRetries: 2,
    fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: "too many tokens" } }), {
        status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "0" },
      });
    },
  });
  await assert.rejects(collect(model, baseRequest), /after 2 rate-limit retries/);
  assert.equal(attempts, 3);
});

test("abort while waiting to retry 429 stops requests and preserves the user reason", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: "TPM exceeded" } }), {
        status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "20" },
      });
    },
  });
  await assert.rejects(async () => {
    for await (const event of model.stream(baseRequest, controller.signal)) {
      if (event.type === "rate_limit.retry") controller.abort(new Error("user cancelled retry"));
    }
  }, /user cancelled retry/);
  assert.equal(attempts, 1);
});

test("non-rate-limit HTTP errors fail immediately without retries", async () => {
  let attempts = 0;
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400, statusText: "Bad Request",
      });
    },
  });
  await assert.rejects(collect(model, baseRequest), /400 Bad Request/);
  assert.equal(attempts, 1);
});

test("provider rejects out-of-range retry policy", () => {
  assert.throws(
    () => new OpenAIResponsesModel({
      apiKey: "test-key", model: "test-model", maxRateLimitRetries: 100,
    }),
    /maxRateLimitRetries/,
  );
});


test("Responses adapter records actual server token usage when supplied", async () => {
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => sseResponse([
      { type: "response.completed", response: {
        usage: { input_tokens: 120, output_tokens: 37, total_tokens: 157 },
      } },
    ]),
  });
  assert.deepEqual(await collect(model, baseRequest), [{
    type: "response.completed",
    usage: { inputTokens: 120, outputTokens: 37, totalTokens: 157 },
  }]);
});

test("network failures include their original transport cause", async () => {
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    },
  });
  await assert.rejects(collect(model, baseRequest), /network request failed.*ECONNRESET/i);
});

test("raw trace captures outgoing JSON and incoming SSE without storing Authorization header", async () => {
  const trace: Array<{ type: string; data: unknown }> = [];
  const model = new OpenAIResponsesModel({
    apiKey: "do-not-log-this-secret", model: "test-model",
    trace: { record(type, data) { trace.push({ type, data }); } },
    fetchImpl: async () => sseResponse([{ type: "response.completed" }]),
  });
  await collect(model, baseRequest);
  assert.deepEqual(trace.map(x => x.type), ["http.request", "http.status", "http.sse"]);
  assert.doesNotMatch(JSON.stringify(trace), /do-not-log-this-secret/);
  assert.match(JSON.stringify(trace[0]), /read_file/);
});


test("final answer mode disables provider tool selection", async () => {
  let body: Record<string, unknown> = {};
  const model = new OpenAIResponsesModel({
    apiKey: "test-key", model: "test-model",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        { type: "response.output_text.delta", delta: "Final answer" },
        { type: "response.completed" },
      ]);
    },
  });
  const events = await collect(model, { ...baseRequest, tools: [] });
  assert.equal(body.tool_choice, "none");
  assert.deepEqual(body.tools, []);
  assert.match(String(body.instructions), /Give the best possible final answer/);
  assert.ok(events.some(event => event.type === "text.delta"));
});
