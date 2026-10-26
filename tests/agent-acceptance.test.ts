import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { TurnRunner } from "../src/agent/turn-runner";
import { EventBus } from "../src/events/event-bus";
import { InMemoryEventStore } from "../src/events/in-memory-event-store";
import type { Model } from "../src/model/model";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import { searchCodeTool } from "../src/tools/tools/search-code";

test("acceptance: multi-pattern source inspection yields grounded API usage in two model steps", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-acceptance-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "ids.ts"),
    'import { randomUUID, createHash } from "node:crypto";\n' +
    "export function newId() {\n  return randomUUID();\n}\n" +
    'export function digest(s: string) {\n  return createHash("sha256").update(s).digest("hex");\n}\n');
  await writeFile(path.join(cwd, "src", "data.ts"),
    'import { readFile } from "node:fs/promises";\n' +
    'export async function load() {\n  return readFile("some.txt", "utf8");\n}\n');

  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(searchCodeTool);
  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator);
  let steps = 0;
  const model: Model = {
    async *stream(request) {
      steps++;
      if (steps === 1) {
        yield { type: "tool.call", call: { id: "scan", name: "search_code",
          input: { path: "src",
            query: ["node:", "createHash(", "randomUUID(", "readFile("],
            contextLines: 1 } } };
      } else {
        const source = request.messages.filter(m => m.role === "tool")
          .map(m => m.content).join("\n");
        assert.match(source, /src\/ids\.ts:1:.*node:crypto/);
        assert.match(source, /src\/ids\.ts:3:.*randomUUID\(\)/);
        assert.match(source, /src\/ids\.ts:6:.*createHash\("sha256"\)/);
        assert.match(source, /src\/data\.ts:3:.*readFile\("some\.txt"/);
        assert.match(source, /src\/ids\.ts:2-:/, "line context should be present");
        yield { type: "text.delta", text:
          "node:crypto randomUUID: src/ids.ts:3; createHash sha256: src/ids.ts:6. " +
          "node:fs/promises readFile: src/data.ts:3." };
      }
      yield { type: "response.completed" };
    },
  };

  const runtime = new AgentRuntime(new TurnRunner(model, orchestrator, scheduler, events,
    { maxSteps: 8, contextBudget: 4000 }), events, store);
  const result = await runtime.runTurn(runtime.createSession(cwd),
    "Find all node: modules and explain each used method with source paths.");
  assert.equal(result.type, "completed");
  if (result.type === "completed") {
    assert.match(result.answer, /randomUUID.*src\/ids\.ts:3/);
    assert.match(result.answer, /readFile.*src\/data\.ts:3/);
  }
  assert.equal(steps, 2, "one bounded search and one answer, without repeated queries");
  assert.equal(store.all().filter(e => e.type === "tool.completed").length, 1);
  assert.equal(store.all().filter(e => e.type === "turn.loop_detected").length, 0);
});
