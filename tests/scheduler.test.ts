import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceAccess, ToolCall } from "../src/contracts/tool";
import { EventBus } from "../src/events/event-bus";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import type { Tool } from "../src/tools/tool";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const context = {
  cwd: "/workspace",
  sessionId: "session-test",
  turnId: "turn-test",
  stepId: "step-test",
};

type DelayInput = {
  resource: string;
  access: ResourceAccess;
  delayMs: number;
  value: string;
};

function createDelayTool(
  name: string,
  onStart?: (input: DelayInput) => void,
  onFinish?: (input: DelayInput) => void,
): Tool<DelayInput, string> {
  return {
    name,
    description: "Test scheduling tool",
    inputSchema: { type: "object" },

    validate(input) {
      return input as DelayInput;
    },

    plan(input) {
      return {
        resources: [{ key: input.resource, access: input.access }],
        sideEffect: input.access === "read" ? "none" : "filesystem",
        risk: input.access,
      };
    },

    async execute(input, _context, signal) {
      if (signal.aborted) throw signal.reason;
      onStart?.(input);
      await sleep(input.delayMs);
      if (signal.aborted) throw signal.reason;
      onFinish?.(input);
      return input.value;
    },

    serialize(output) {
      return output;
    },
  };
}

function makeScheduler(tool: Tool<DelayInput, string>, maxConcurrency = 4) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const orchestrator = new ToolOrchestrator(registry, new EventBus());
  return new ToolScheduler(orchestrator, { maxConcurrency });
}

function call(id: string, input: DelayInput): ToolCall {
  return { id, name: "delay", input };
}

test("independent read claims execute concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const tool = createDelayTool(
    "delay",
    () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    },
    () => {
      active -= 1;
    },
  );
  const scheduler = makeScheduler(tool, 4);

  const results = await scheduler.executeBatch(
    [
      call("a", { resource: "file:a", access: "read", delayMs: 40, value: "A" }),
      call("b", { resource: "file:b", access: "read", delayMs: 40, value: "B" }),
    ],
    context,
    new AbortController().signal,
  );

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((result) => result.content), ["A", "B"]);
});

test("read/write conflict on the same resource is serialized", async () => {
  let active = 0;
  let maxActive = 0;
  const starts: string[] = [];
  const tool = createDelayTool(
    "delay",
    (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      starts.push(input.value);
    },
    () => {
      active -= 1;
    },
  );
  const scheduler = makeScheduler(tool, 4);

  await scheduler.executeBatch(
    [
      call("read", { resource: "file:a", access: "read", delayMs: 25, value: "read" }),
      call("write", { resource: "file:a", access: "write", delayMs: 5, value: "write" }),
    ],
    context,
    new AbortController().signal,
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(starts, ["read", "write"]);
});

test("maxConcurrency provides backpressure", async () => {
  let active = 0;
  let maxActive = 0;
  const tool = createDelayTool(
    "delay",
    () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
    },
    () => {
      active -= 1;
    },
  );
  const scheduler = makeScheduler(tool, 2);

  await scheduler.executeBatch(
    [0, 1, 2, 3].map((index) =>
      call(String(index), {
        resource: `file:${index}`,
        access: "read",
        delayMs: 15,
        value: String(index),
      }),
    ),
    context,
    new AbortController().signal,
  );

  assert.equal(maxActive, 2);
});

test("results keep model call order even when completion order differs", async () => {
  const tool = createDelayTool("delay");
  const scheduler = makeScheduler(tool, 3);

  const results = await scheduler.executeBatch(
    [
      call("slow", { resource: "file:a", access: "read", delayMs: 30, value: "slow" }),
      call("fast", { resource: "file:b", access: "read", delayMs: 1, value: "fast" }),
    ],
    context,
    new AbortController().signal,
  );

  assert.deepEqual(results.map((result) => result.callId), ["slow", "fast"]);
  assert.deepEqual(results.map((result) => result.content), ["slow", "fast"]);
});

test("a waiting writer prevents later readers on the same resource from overtaking", async () => {
  const starts: string[] = [];
  const tool = createDelayTool("delay", (input) => starts.push(input.value));
  const scheduler = makeScheduler(tool, 3);

  await scheduler.executeBatch(
    [
      call("r1", { resource: "file:a", access: "read", delayMs: 20, value: "r1" }),
      call("w", { resource: "file:a", access: "write", delayMs: 5, value: "w" }),
      call("r2", { resource: "file:a", access: "read", delayMs: 1, value: "r2" }),
      call("other", { resource: "file:b", access: "read", delayMs: 1, value: "other" }),
    ],
    context,
    new AbortController().signal,
  );

  assert.equal(starts[0], "r1");
  assert.ok(starts.indexOf("other") < starts.indexOf("w"));
  assert.ok(starts.indexOf("w") < starts.indexOf("r2"));
});

test("abort rejects queued scheduling work", async () => {
  const tool = createDelayTool("delay");
  const scheduler = makeScheduler(tool, 1);
  const controller = new AbortController();

  const promise = scheduler.executeBatch(
    [
      call("a", { resource: "file:a", access: "read", delayMs: 50, value: "A" }),
      call("b", { resource: "file:b", access: "read", delayMs: 50, value: "B" }),
    ],
    context,
    controller.signal,
  );

  setTimeout(() => controller.abort(new Error("stop")), 5);
  await assert.rejects(promise, /stop/);
});


test("scheduler reports time spent waiting on a resource conflict", async () => {
  const events = new EventBus();
  const starts: Array<{ callId: string; queueWaitMs: number; queueReason?: string }> = [];
  events.subscribe((event) => {
    if (event.type === "tool.started") {
      starts.push({
        callId: event.callId,
        queueWaitMs: event.queueWaitMs,
        ...(event.queueReason ? { queueReason: event.queueReason } : {}),
      });
    }
  });

  const registry = new ToolRegistry();
  registry.register(createDelayTool("delay"));
  const scheduler = new ToolScheduler(new ToolOrchestrator(registry, events), {
    maxConcurrency: 3,
  });
  await scheduler.executeBatch(
    [
      call("read", { resource: "file:a", access: "read", delayMs: 25, value: "r" }),
      call("write", { resource: "file:a", access: "write", delayMs: 1, value: "w" }),
    ],
    context,
    new AbortController().signal,
  );

  assert.deepEqual(starts.map((entry) => entry.callId), ["read", "write"]);
  assert.equal(starts[1]?.queueReason, "resource_conflict");
  assert.ok(starts[1]!.queueWaitMs >= 0);
});
