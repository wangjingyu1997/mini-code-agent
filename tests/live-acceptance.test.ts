import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { TurnRunner } from "../src/agent/turn-runner";
import { EventBus } from "../src/events/event-bus";
import { InMemoryEventStore } from "../src/events/in-memory-event-store";
import { createModelFromEnv } from "../src/model/create-model";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { ToolScheduler } from "../src/tools/scheduler";
import { readFileTool } from "../src/tools/tools/read-file";
import { searchCodeTool } from "../src/tools/tools/search-code";

/**
 * Opt-in live model evaluation. Regular CI deliberately never calls a paid or
 * rate-limited provider. This test measures observed task quality, not just
 * whether TurnRunner emits turn.completed.
 */
test("LIVE: Groq explains actual Node.js API calls with verifiable file evidence",
  { skip: process.env.AGENT_LIVE_ACCEPTANCE !== "1" }, async (t) => {
    assert.equal(process.env.MODEL_PROVIDER, "groq",
      "run with MODEL_PROVIDER=groq and GROQ_API_KEY in your .env");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-live-acceptance-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "ids.ts"),
      'import { createHash, randomUUID } from "node:crypto";\n' +
      'export const newId = () => randomUUID();\n' +
      'export const digest = (x: string) => createHash("sha256").update(x).digest("hex");\n');
    await writeFile(path.join(cwd, "src", "reader.ts"),
      'import { readFile } from "node:fs/promises";\n' +
      'export const load = () => readFile("data.txt", "utf8");\n');

    const events = new EventBus();
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register(searchCodeTool);
    registry.register(readFileTool);
    const orchestrator = new ToolOrchestrator(registry, events);
    const scheduler = new ToolScheduler(orchestrator);
    const runtime = new AgentRuntime(new TurnRunner(
      createModelFromEnv(process.env), orchestrator, scheduler, events,
      { maxSteps: 10, contextBudget: 4000, maxToolOutputChars: 5000 },
    ), events, store);
    const result = await runtime.runTurn(runtime.createSession(cwd),
      "使用 search_code 搜索 src 下 node: 导入。找出所有 Node.js 内置模块、" +
      "成员及它们在函数体中的真实调用位置和作用。必须引用 src/ 文件路径，" +
      "解释 createHash、randomUUID、readFile 的具体调用方式，不能只根据 import 推测。");
    assert.equal(result.type, "completed",
      "Agent must answer, not only exhaust maxSteps or fail");
    if (result.type !== "completed") return;
    for (const symbol of ["node:crypto", "node:fs/promises", "createHash",
      "randomUUID", "readFile", "src/ids.ts", "src/reader.ts"]) {
      assert.ok(result.answer.includes(symbol), "Missing grounded requirement: " + symbol);
    }
    const executed = store.all().filter(e => e.type === "tool.completed");
    assert.ok(executed.length > 0, "Agent must inspect actual fixture source");
    assert.ok(result.steps <= 10);
  });
