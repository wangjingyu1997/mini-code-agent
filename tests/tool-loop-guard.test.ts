import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolLoopGuard } from "../src/agent/tool-loop-guard";
import { TurnRunner } from "../src/agent/turn-runner";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { EventBus } from "../src/events/event-bus";
import { InMemoryEventStore } from "../src/events/in-memory-event-store";
import type { Model } from "../src/model/model";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import { listFilesTool } from "../src/tools/tools/list-files";

test("loop guard detects identical read-only evidence and tolerates new facts", () => {
  const guard = new ToolLoopGuard(2);
  const observe = (id: string, content: string) =>
    guard.observe([{ id, name: "list_files", input: { path: "." } }],
      [{ callId: id, toolName: "list_files", content, isError: false }]);
  assert.equal(observe("one", "a"), false);
  assert.equal(observe("two", "a"), false);
  assert.equal(observe("three", "changed"), false);
  assert.equal(observe("four", "changed"), false);
  assert.equal(observe("five", "changed"), true);
  const mutation = { id: "patch", name: "apply_patch", input: {} };
  assert.equal(guard.observe([mutation],
    [{ callId: "patch", toolName: "apply_patch", content: "ok", isError: false }]), false);
  assert.equal(observe("six", "changed"), false);
});

test("repeating read-only tools transitions to one final no-tools model call", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await writeFile(path.join(cwd, "file.txt"), "hello", "utf8");

  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(listFilesTool);
  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator);
  const requestedTools: number[] = [];
  const model: Model = {
    async *stream(request) {
      requestedTools.push(request.tools.length);
      if (request.tools.length === 0) {
        assert.equal(request.messages.length, 1, "tool history must be flattened for final answer");
        assert.equal(request.messages[0]?.role, "user");
        assert.match((request.messages[0] as { content: string }).content, /file.txt/);
        yield { type: "text.delta", text: "Directory contains file.txt; no more tools needed." };
      } else {
        yield { type: "tool.call", call: {
          id: "call-" + requestedTools.length,
          name: "list_files",
          input: { path: "." },
        } };
      }
      yield { type: "response.completed" };
    },
  };

  const runtime = new AgentRuntime(new TurnRunner(
    model, orchestrator, scheduler, events,
    { maxSteps: 12, contextBudget: 2000 },
  ), events, store);
  const result = await runtime.runTurn(runtime.createSession(cwd), "List files and answer.");
  assert.equal(result.type, "completed");
  if (result.type === "completed") {
    assert.match(result.answer, /file.txt/);
    assert.ok(result.steps < 12);
  }
  assert.deepEqual(requestedTools, [1, 1, 1, 0]);
});

test("max_steps returns a terminal event visible to observers and trace", async () => {
  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator);
  const model: Model = {
    async *stream() {
      yield { type: "tool.call", call: { id: "unknown", name: "no_such_tool", input: {} } };
      yield { type: "response.completed" };
    },
  };
  const runtime = new AgentRuntime(new TurnRunner(model,
    orchestrator, scheduler, events, { maxSteps: 2 }),
  events, store);
  const result = await runtime.runTurn(runtime.createSession(process.cwd()), "demo");
  assert.equal(result.type, "max_steps");
  const ends = store.all().filter(e => e.type === "turn.max_steps");
  assert.equal(ends.length, 1);
  if (ends[0]?.type === "turn.max_steps") assert.equal(ends[0].steps, 2);
});
