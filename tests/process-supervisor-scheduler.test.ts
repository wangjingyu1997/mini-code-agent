import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../src/events/event-bus";
import { ToolOrchestrator } from "../src/tools/orchestrator";
import { ToolRegistry } from "../src/tools/registry";
import { conservativeExecutionPlan } from "../src/tools/resource";
import { ToolScheduler } from "../src/tools/scheduler";
import type { Tool } from "../src/tools/tool";
import { createBashTool } from "../src/tools/tools/bash";

test("scheduler retains bash workspace claim after batch abort until supervised process settles",
  { skip: process.platform === "win32" ? "Unix process-group termination required" : false },
  async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-scheduler-bash-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const context = { cwd, sessionId: "session", turnId: "turn", stepId: "step" };

    const registry = new ToolRegistry();
    registry.register(createBashTool({ approve: async () => true, timeoutMs: 5000 }));
    let probeStarted = false;

    const probe: Tool<unknown, string> = {
      name: "workspace_probe",
      description: "Test tool contending for the full workspace",
      inputSchema: { type: "object" },
      validate(input) { return input; },
      plan() { return conservativeExecutionPlan; },
      async execute() { probeStarted = true; return "probe"; },
      serialize(output) { return output; },
    };
    registry.register(probe);

    const scheduler = new ToolScheduler(new ToolOrchestrator(registry, new EventBus()), {
      maxConcurrency: 2,
    });
    const controller = new AbortController();
    const first = scheduler.executeBatch([{
      id: "shell",
      name: "bash",
      input: {
        command: "trap '' TERM; printf ready > ready.txt; while :; do sleep 0.05; done",
      },
    }], context, controller.signal);

    let foundReady = false;
    for (let i = 0; i < 200; i++) {
      try {
        foundReady = (await readFile(path.join(cwd, "ready.txt"), "utf8")) === "ready";
        if (foundReady) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(foundReady, true, "bash must be running before abort");

    const second = scheduler.executeBatch([{
      id: "probe",
      name: "workspace_probe",
      input: {},
    }], context, new AbortController().signal);

    controller.abort(new Error("stop shell batch"));
    await assert.rejects(first, /stop shell batch/);

    // This batch is already rejected, but its shell still ignores SIGTERM.
    // No other workspace writer is permitted to run until SIGKILL escalation
    // makes the Bash tool's execution Promise settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(probeStarted, false);

    const results = await second;
    assert.equal(results[0]!.content, "probe");
    assert.equal(probeStarted, true);
  });
