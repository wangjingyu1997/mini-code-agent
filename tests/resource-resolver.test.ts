import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExecutionPlan, ResourceAccess, ToolCall } from "../src/contracts/tool";
import { EventBus } from "../src/events/event-bus";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ResourceResolver } from "../src/tools/resource-resolver";
import { workspacePathResource } from "../src/tools/resource";
import { ToolScheduler } from "../src/tools/scheduler";
import type { Tool } from "../src/tools/tool";

type EditInput = { path: string; label: string; access: ResourceAccess };
type Gate = { promise: Promise<void>; release(): void };
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const context = (cwd: string) => ({
  cwd, sessionId: "session", turnId: "turn", stepId: "step",
});
const call = (label: string, pathName: string, access: ResourceAccess = "write"): ToolCall => ({
  id: label,
  name: "file_operation",
  input: { path: pathName, label, access },
});

function harness(cwd: string, resolver?: { resolve(plan: ExecutionPlan): Promise<ExecutionPlan> }) {
  const starts: string[] = [];
  const gates = new Map<string, Gate>();
  const tool: Tool<EditInput, string> = {
    name: "file_operation",
    description: "Controlled filesystem operation",
    inputSchema: { type: "object" },
    validate(input) { return input as EditInput; },
    plan(input, ctx) {
      return {
        resources: [{ key: workspacePathResource(ctx.cwd, input.path), access: input.access }],
        sideEffect: "filesystem",
        risk: input.access,
      };
    },
    async execute(input) {
      starts.push(input.label);
      await gates.get(input.label)!.promise;
      return input.label;
    },
    serialize(output) { return output; },
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const options = resolver
    ? { maxConcurrency: 3, resourceResolver: resolver }
    : { maxConcurrency: 3 };
  const scheduler = new ToolScheduler(new ToolOrchestrator(registry, new EventBus()), options);
  return {
    scheduler,
    starts,
    reserve(label: string, pathName: string, access: ResourceAccess = "write") {
      gates.set(label, gate());
      return call(label, pathName, access);
    },
    release(label: string) { gates.get(label)!.release(); },
    context: context(cwd),
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Timed out: " + message);
}

async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "resource-resolver-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("realpath resolver maps symlink and target to the same resource key", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "target.ts"), "original", "utf8");
  await symlink("target.ts", path.join(cwd, "alias.ts"));
  const resolver = new ResourceResolver();
  const a = await resolver.resolve({
    resources: [{ key: workspacePathResource(cwd, "target.ts"), access: "write" }],
    sideEffect: "filesystem",
    risk: "write",
  });
  const b = await resolver.resolve({
    resources: [{ key: workspacePathResource(cwd, "alias.ts"), access: "read" }],
    sideEffect: "filesystem",
    risk: "read",
  });
  assert.equal(a.resources[0]!.key, b.resources[0]!.key);
  assert.equal(a.resources[0]!.key, workspacePathResource(cwd, "target.ts"));
});

test("symlink-alias read and write cannot run concurrently across batches", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "target.ts"), "original", "utf8");
  await symlink("target.ts", path.join(cwd, "alias.ts"));
  const h = harness(cwd);
  const first = h.scheduler.executeBatch(
    [h.reserve("writer", "target.ts")],
    h.context, new AbortController().signal,
  );
  await waitFor(() => h.starts.includes("writer"), "writer started");

  const second = h.scheduler.executeBatch(
    [h.reserve("reader", "alias.ts", "read")],
    h.context, new AbortController().signal,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.starts, ["writer"]);
  h.release("writer");
  await first;
  await waitFor(() => h.starts.includes("reader"), "reader started after writer");
  h.release("reader");
  await second;
});

test("independent real files still start concurrently", async (t) => {
  const cwd = await workspace(t);
  await writeFile(path.join(cwd, "a.ts"), "a");
  await writeFile(path.join(cwd, "b.ts"), "b");
  const h = harness(cwd);
  const result = h.scheduler.executeBatch([
    h.reserve("a", "a.ts"),
    h.reserve("b", "b.ts"),
  ], h.context, new AbortController().signal);
  await waitFor(() => h.starts.length === 2, "both files started");
  h.release("a");
  h.release("b");
  assert.deepEqual((await result).map((r) => r.content), ["a", "b"]);
});

test("later and faster resolution cannot overtake an earlier conflicting task", async () => {
  const holdFirst = gate();
  const resolver = {
    async resolve(plan: ExecutionPlan): Promise<ExecutionPlan> {
      if (plan.resources.some((c) => c.key.endsWith("/first"))) await holdFirst.promise;
      return {
        ...plan,
        resources: [{ key: "workspace:path:/shared", access: "write" as const }],
      };
    },
  };
  const h = harness("/tmp/resource-test", resolver);
  const a = h.scheduler.executeBatch(
    [h.reserve("first", "first")], h.context, new AbortController().signal,
  );
  const b = h.scheduler.executeBatch(
    [h.reserve("second", "second")], h.context, new AbortController().signal,
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(h.starts, [], "second must not overtake unresolved first");
  holdFirst.release();
  await waitFor(() => h.starts.includes("first"), "first started");
  assert.deepEqual(h.starts, ["first"]);
  h.release("first");
  await a;
  await waitFor(() => h.starts.includes("second"), "second started");
  h.release("second");
  await b;
});

test("abort during resource resolution removes that batch without starting its tool", async () => {
  const holdFirst = gate();
  const resolver = {
    async resolve(plan: ExecutionPlan): Promise<ExecutionPlan> {
      if (plan.resources.some((c) => c.key.endsWith("/first"))) await holdFirst.promise;
      return plan;
    },
  };
  const h = harness("/tmp/resource-test", resolver);
  const controller = new AbortController();
  const a = h.scheduler.executeBatch([h.reserve("first", "first")], h.context, controller.signal);
  const b = h.scheduler.executeBatch([h.reserve("second", "second")], h.context, new AbortController().signal);
  controller.abort(new Error("cancelled during resolution"));
  await assert.rejects(a, /cancelled during resolution/);

  await waitFor(() => h.starts.includes("second"), "second started after cancelled reservation");
  assert.deepEqual(h.starts, ["second"]);
  h.release("second");
  await b;
  holdFirst.release();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.starts, ["second"]);
});

test("realpath failures are returned as tool errors without executing the unsafe tool", async (t) => {
  const cwd = await workspace(t);
  const h = harness(cwd);
  const result = await h.scheduler.executeBatch(
    [h.reserve("missing", "missing.ts")],
    h.context, new AbortController().signal,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.isError, true);
  assert.equal(h.starts.length, 0);
  assert.match(result[0]!.content, /ENOENT|no such file/i);
});
