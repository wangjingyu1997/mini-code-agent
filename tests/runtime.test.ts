import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { TurnRunner } from "../src/agent/turn-runner";
import { EventBus } from "../src/events/event-bus";
import { InMemoryEventStore } from "../src/events/in-memory-event-store";
import { MockModel } from "../src/model/mock-model";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import { listFilesTool } from "../src/tools/tools/list-files";
import { readFileTool } from "../src/tools/tools/read-file";

function makeRuntime() {
  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listFilesTool);

  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator);
  const runner = new TurnRunner(new MockModel(), orchestrator, scheduler, events);
  const runtime = new AgentRuntime(runner, events, store);
  return { runtime, store };
}

test("runtime performs model -> tool -> model across two steps", async () => {
  const { runtime, store } = makeRuntime();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-runtime-"));
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fixture-project" }),
    "utf8",
  );
  const session = runtime.createSession(cwd);

  const result = await runtime.runTurn(session, "读取 package.json");

  assert.equal(result.type, "completed");
  if (result.type !== "completed") return;

  assert.equal(result.steps, 2);
  assert.match(result.answer, /read_file/);
  assert.ok(session.history.some((message) => message.role === "assistant_tool_call"));
  assert.ok(session.history.some((message) => message.role === "tool"));

  const eventTypes = store.all().map((event) => event.type);
  assert.ok(eventTypes.includes("tool.requested"));
  assert.ok(eventTypes.includes("tool.started"));
  assert.ok(eventTypes.includes("tool.completed"));
  assert.ok(eventTypes.includes("turn.completed"));

  const modelMetrics = store.all().filter((event) => event.type === "model.completed");
  assert.equal(modelMetrics.length, 2);
  assert.ok(modelMetrics.every((event) => event.durationMs >= 0));

  const completedTools = store.all().filter((event) => event.type === "tool.completed");
  assert.equal(completedTools.length, 1);
  assert.ok(completedTools[0]!.durationMs >= 0);

  const startedTools = store.all().filter((event) => event.type === "tool.started");
  assert.equal(startedTools.length, 1);
  assert.ok(startedTools[0]!.queueWaitMs >= 0);
});

test("runtime returns aborted when signal is already aborted", async () => {
  const { runtime } = makeRuntime();
  const session = runtime.createSession(process.cwd());
  const controller = new AbortController();
  controller.abort(new Error("test abort"));

  const result = await runtime.runTurn(
    session,
    "读取 package.json",
    controller.signal,
  );

  assert.equal(result.type, "aborted");
});
