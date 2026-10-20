import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceAccess, ToolCall } from "../src/contracts/tool";
import { EventBus } from "../src/events/event-bus";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import type { Tool } from "../src/tools/tool";

type Request = { label: string; resource: string; access: ResourceAccess };
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeHarness(options: {
  maxConcurrency?: number;
  failWith?: string;
} = {}) {
  const active = new Set<string>();
  const starts: string[] = [];
  const maxSeen: { value: number } = { value: 0 };
  const gates = new Map<string, Deferred<string>>();

  const tool: Tool<Request, string> = {
    name: "controlled",
    description: "Deterministic scheduling test tool",
    inputSchema: { type: "object" },
    validate(input) { return input as Request; },
    plan(input) {
      return {
        resources: [{ key: input.resource, access: input.access }],
        sideEffect: input.access === "write" ? "filesystem" : "none",
        risk: input.access,
      };
    },
    async execute(input) {
      starts.push(input.label);
      active.add(input.label);
      maxSeen.value = Math.max(maxSeen.value, active.size);
      try {
        return await gates.get(input.label)!.promise;
      } finally {
        active.delete(input.label);
      }
    },
    serialize(output) { return output; },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const scheduler = new ToolScheduler(
    new ToolOrchestrator(registry, new EventBus()),
    { maxConcurrency: options.maxConcurrency ?? 4 },
  );

  return {
    starts,
    active,
    maxSeen,
    scheduler,
    call(label: string, resource = "file:a", access: ResourceAccess = "write"): ToolCall {
      gates.set(label, deferred<string>());
      return { id: label, name: "controlled", input: { label, resource, access } };
    },
    release(label: string) { gates.get(label)!.resolve(label); },
    fail(label: string) { gates.get(label)!.reject(new Error("injected: " + label)); },
  };
}

const context = {
  cwd: "/workspace",
  sessionId: "s",
  turnId: "t",
  stepId: "step",
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(condition: () => boolean, hint: string): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for: " + hint);
}

test("different batches serialize conflicting writes on one scheduler instance", async () => {
  const h = makeHarness();
  const a = h.scheduler.executeBatch([h.call("a")], context, new AbortController().signal);
  await waitFor(() => h.starts.includes("a"), "a started");

  const b = h.scheduler.executeBatch([h.call("b")], context, new AbortController().signal);
  await tick();
  assert.deepEqual(h.starts, ["a"]);

  h.release("a");
  assert.deepEqual((await a).map((r) => r.callId), ["a"]);
  await waitFor(() => h.starts.includes("b"), "b started");
  h.release("b");
  assert.deepEqual((await b).map((r) => r.callId), ["b"]);
  assert.equal(h.maxSeen.value, 1);
});

test("waiting writer blocks later reader across batch boundaries, unrelated work proceeds", async () => {
  const h = makeHarness();
  const a = h.scheduler.executeBatch([h.call("r1", "file:a", "read")], context, new AbortController().signal);
  await waitFor(() => h.starts.includes("r1"), "r1 started");
  const b = h.scheduler.executeBatch([h.call("w", "file:a", "write")], context, new AbortController().signal);
  const c = h.scheduler.executeBatch([
    h.call("r2", "file:a", "read"),
    h.call("independent", "file:b", "read"),
  ], context, new AbortController().signal);

  await waitFor(() => h.starts.includes("independent"), "independent read started");
  assert.equal(h.starts.includes("w"), false);
  assert.equal(h.starts.includes("r2"), false);
  h.release("independent");

  h.release("r1");
  await a;
  await waitFor(() => h.starts.includes("w"), "writer started");
  assert.equal(h.starts.includes("r2"), false);

  h.release("w");
  await b;
  await waitFor(() => h.starts.includes("r2"), "late reader started");
  h.release("r2");
  assert.deepEqual((await c).map((r) => r.content), ["r2", "independent"]);
});

test("maxConcurrency applies across batches, not independently per batch", async () => {
  const h = makeHarness({ maxConcurrency: 2 });
  const a = h.scheduler.executeBatch([
    h.call("a", "file:a"),
    h.call("b", "file:b"),
  ], context, new AbortController().signal);
  await waitFor(() => h.starts.length === 2, "two slots filled");

  const b = h.scheduler.executeBatch([h.call("c", "file:c")], context, new AbortController().signal);
  await tick();
  assert.equal(h.starts.includes("c"), false);

  h.release("a");
  await waitFor(() => h.starts.includes("c"), "c admitted");
  h.release("c");
  h.release("b");
  await Promise.all([a, b]);
  assert.equal(h.maxSeen.value, 2);
});

test("aborting queued batch removes only its pending tasks", async () => {
  const h = makeHarness({ maxConcurrency: 1 });
  const a = h.scheduler.executeBatch([h.call("a")], context, new AbortController().signal);
  await waitFor(() => h.starts.includes("a"), "a started");
  const cancel = new AbortController();
  const b = h.scheduler.executeBatch([h.call("b")], context, cancel.signal);
  const c = h.scheduler.executeBatch([h.call("c")], context, new AbortController().signal);

  cancel.abort(new Error("cancel batch b"));
  await assert.rejects(b, /cancel batch b/);
  h.release("a");
  await a;
  await waitFor(() => h.starts.includes("c"), "c started");
  h.release("c");
  await c;
  assert.deepEqual(h.starts, ["a", "c"]);
});

test("aborted running batch retains its resource until in-flight execution really settles", async () => {
  const h = makeHarness({ maxConcurrency: 2 });
  const cancel = new AbortController();
  const a = h.scheduler.executeBatch([h.call("a")], context, cancel.signal);
  await waitFor(() => h.starts.includes("a"), "a started");

  const b = h.scheduler.executeBatch([h.call("b")], context, new AbortController().signal);
  cancel.abort(new Error("stop a"));
  await assert.rejects(a, /stop a/);
  await tick();
  assert.deepEqual(h.starts, ["a"], "cancellation must not prematurely unlock in-flight write");

  h.release("a"); // Simulates a tool that does not immediately cooperate with abort.
  await waitFor(() => h.starts.includes("b"), "b started after a settled");
  h.release("b");
  await b;
  assert.equal(h.maxSeen.value, 1);
});

test("unexpected batch execution failure does not poison another batch", async () => {
  const h = makeHarness({ maxConcurrency: 2 });
  const a = h.scheduler.executeBatch([h.call("a")], context, new AbortController().signal);
  await waitFor(() => h.starts.includes("a"), "a started");
  const b = h.scheduler.executeBatch([h.call("b")], context, new AbortController().signal);

  h.fail("a");
  const failedToolResults = await a;
  assert.equal(failedToolResults[0]!.isError, true);
  await waitFor(() => h.starts.includes("b"), "b started");
  h.release("b");
  assert.equal((await b)[0]!.content, "b");
});

test("results from overlapping batches are isolated and keep request order", async () => {
  const h = makeHarness();
  const a = h.scheduler.executeBatch([
    h.call("slow-a", "file:a"),
    h.call("fast-a", "file:b"),
  ], context, new AbortController().signal);
  const b = h.scheduler.executeBatch([
    h.call("fast-b", "file:c"),
  ], context, new AbortController().signal);

  await waitFor(() => h.starts.length === 3, "all independent tasks started");
  h.release("fast-b");
  h.release("fast-a");
  h.release("slow-a");

  assert.deepEqual((await a).map((r) => r.content), ["slow-a", "fast-a"]);
  assert.deepEqual((await b).map((r) => r.content), ["fast-b"]);
});
