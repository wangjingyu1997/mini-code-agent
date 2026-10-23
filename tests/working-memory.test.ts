import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { buildContext } from "../src/agent/context-budget";
import { buildFinalAnswerContext } from "../src/agent/final-answer-context";
import { TaskProgress } from "../src/agent/task-progress";
import { toolRequestKey } from "../src/agent/tool-key";
import { TurnRunner } from "../src/agent/turn-runner";
import { EventBus } from "../src/events/event-bus";
import { InMemoryEventStore } from "../src/events/in-memory-event-store";
import type { Model } from "../src/model/model";
import type { AgentMessage } from "../src/model/types";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import { readFileTool } from "../src/tools/tools/read-file";
import { searchCodeTool } from "../src/tools/tools/search-code";

test("tool identity is stable across object key orders", () => {
  assert.equal(
    toolRequestKey("search_code", { path: "src", query: "node:" }),
    toolRequestKey("search_code", { query: "node:", path: "src" }),
  );
  assert.notEqual(
    toolRequestKey("search_code", { path: "src" }),
    toolRequestKey("read_file", { path: "src" }),
  );
});

test("TaskProgress captures unique evidence, deduplicates, and invalidates on mutations", () => {
  const progress = new TaskProgress("Find node imports");
  const call = { id: "A", name: "search_code", input: { path: "src", query: "node:" } };
  const result = { callId: "A", toolName: "search_code", isError: false,
    content: 'Scanned 2 files; 1 matches\nsrc/a.ts:1: import { randomUUID } from "node:crypto";' };
  assert.equal(progress.recordBatch([call], [result]).distinctEvidence, 1);
  assert.match(progress.contextNote(), /node:crypto/);
  const repeat = { ...call, id: "B", input: { query: "node:", path: "src" } };
  const snapshot = progress.recordBatch([repeat], [{ ...result, callId: "B" }]);
  assert.equal(snapshot.distinctEvidence, 1);
  assert.equal(snapshot.repeatedReads, 1);
  const changed = progress.recordBatch([repeat], [
    { ...result, callId: "B", content: "Scanned 2 files; 0 matches" },
  ]);
  assert.equal(changed.changedReads, 1);
  assert.equal(changed.distinctEvidence, 1);

  const patch = { id: "C", name: "apply_patch", input: { path: "src/a.ts" } };
  const invalidated = progress.recordBatch([patch], [
    { callId: "C", toolName: "apply_patch", isError: true, content: "partial failure" },
  ]);
  assert.equal(invalidated.distinctEvidence, 0);
  assert.equal(invalidated.invalidations, 1);
  assert.equal(progress.contextNote(), "");
});

test("working memory retains prior search evidence despite regular context compaction", () => {
  const progress = new TaskProgress("Explain Node.js imports");
  progress.recordBatch([{ id: "search", name: "search_code", input: { path: "src", query: "node:" } }],
    [{ callId: "search", toolName: "search_code", isError: false,
      content: 'Scanned 30 files; 24 matches\nsrc/a.ts:1: import { randomUUID } from "node:crypto";' }]);
  const history: AgentMessage[] = [
    { role: "user", content: "Explain Node.js imports" },
    { role: "assistant_tool_call", callId: "search", toolName: "search_code",
      input: { path: "src", query: "node:" } },
    { role: "tool", callId: "search", toolName: "search_code",
      content: "S".repeat(5000), isError: false },
    { role: "assistant_tool_call", callId: "read", toolName: "read_file",
      input: { path: "src/large.ts" } },
    { role: "tool", callId: "read", toolName: "read_file",
      content: "F".repeat(7000), isError: false },
  ];
  const context = buildContext(history, { maxEstimatedTokens: 950, maxToolOutputChars: 1000 },
    [{ name: "read_file", description: "a tool" }], progress.contextNote());
  const text = context.messages.filter(m => m.role === "user").map(m => m.content).join("\n");
  assert.match(text, /node:crypto/);
  assert.match(text, /Explain Node\.js imports/);
  assert.equal(context.compacted, true);
  assert.ok(context.estimatedTokens <= 950);
});

test("final recovery prefers authoritative turn EvidenceStore over truncated history", () => {
  const progress = new TaskProgress("List node imports");
  const call = { id: "s", name: "search_code", input: { path: "src", query: "node:" } };
  progress.recordBatch([call], [{
    callId: "s", toolName: "search_code", isError: false,
    content: 'Scanned 30 files; 1 matches\nsrc/a.ts:1: import { randomUUID } from "node:crypto";',
  }]);
  const result = buildFinalAnswerContext([
    { role: "user", content: "List node imports" },
    { role: "assistant_tool_call", callId: "s", toolName: "search_code", input: call.input },
    { role: "tool", callId: "s", toolName: "search_code", content: "old truncated result",
      isError: false },
  ], 1200, progress.orderedEvidence());
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  const text = result.messages[0]?.role === "user" ? result.messages[0].content : "";
  assert.match(text, /node:crypto/);
  assert.doesNotMatch(text, /old truncated result/);
});

test("TurnRunner carries original search inventory into a later model step", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.ts"),
    'import { randomUUID } from "node:crypto";\n');
  await writeFile(path.join(cwd, "src", "large.ts"),
    'import { readFile } from "node:fs/promises";\n' + "const x = 0;\n".repeat(800));
  const events = new EventBus();
  const registry = new ToolRegistry();
  registry.register(searchCodeTool);
  registry.register(readFileTool);
  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator);
  let step = 0;
  const model: Model = {
    async *stream(request) {
      step++;
      if (step === 1) {
        yield { type: "tool.call", call: { id: "s", name: "search_code",
          input: { path: "src", query: "node:" } } };
      } else if (step === 2) {
        yield { type: "tool.call", call: { id: "r", name: "read_file",
          input: { path: "src/large.ts" } } };
      } else {
        const allText = request.messages.filter(x => x.role === "user")
          .map(x => x.content).join("\n");
        assert.match(allText, /node:crypto/,
          "older search evidence must survive despite oversized read_file result");
        yield { type: "text.delta", text: "Found node:crypto and node:fs/promises." };
      }
      yield { type: "response.completed" };
    },
  };
  const store = new InMemoryEventStore();
  const runner = new TurnRunner(model, orchestrator, scheduler, events,
    { contextBudget: 1100, maxToolOutputChars: 5000 });
  const runtime = new AgentRuntime(runner, events, store);
  const outcome = await runtime.runTurn(runtime.createSession(cwd), "Explain node: imports");
  assert.equal(outcome.type, "completed");
  assert.equal(step, 3);
  const updates = store.all().filter(e => e.type === "task.progress.updated");
  assert.equal(updates.length, 2);
  assert.equal(updates[1]?.type === "task.progress.updated" && updates[1].distinctEvidence, 2);
});
