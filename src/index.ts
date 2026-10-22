import process from "node:process";
import readline from "node:readline/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { AgentRuntime } from "./agent/agent-runtime";
import { TurnRunner } from "./agent/turn-runner";
import { EventBus } from "./events/event-bus";
import { InMemoryEventStore } from "./events/in-memory-event-store";
import { JsonlEventRecorder } from "./events/jsonl-event-recorder";
import { createModelFromEnv } from "./model/create-model";
import { ToolOrchestrator } from "./tools/orchestrator";
import { ToolRegistry } from "./tools/registry";
import { ToolScheduler } from "./tools/scheduler";
import { applyPatchTool } from "./tools/tools/apply-patch";
import { applyPatchSetTool } from "./tools/tools/apply-patch-set";
import { createBashTool } from "./tools/tools/bash";
import { listFilesTool } from "./tools/tools/list-files";
import { TerminalUI } from "./cli/terminal-ui";
import { RawTraceRecorder } from "./observability/raw-trace-recorder";
import { readFileTool } from "./tools/tools/read-file";

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const ui = new TerminalUI(output);
  const events = new EventBus();
  const trace = process.env.AGENT_TRACE === "1"
    ? new RawTraceRecorder(path.join(process.cwd(), ".mini-code-agent", "logs", "raw-trace.jsonl"))
    : undefined;
  if (trace) events.subscribe((event) => trace.recordEvent(event));
  const store = new InMemoryEventStore();
  const recorder = new JsonlEventRecorder(
    path.join(process.cwd(), ".mini-code-agent", "logs", "events.jsonl"),
  );
  events.subscribe((event) => recorder.record(event));
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listFilesTool);
  registry.register(applyPatchTool);
  registry.register(applyPatchSetTool);
  registry.register(createBashTool({
    approve: async ({ command, cwd }, signal) => {
      ui.approvalRequest(command, cwd);
      try {
        const answer = await rl.question(ui.permissionPrompt(), { signal });
        const allowed = ["y", "yes"].includes(answer.trim().toLowerCase());
        ui.approvalResult(allowed);
        return allowed;
      } catch {
        ui.approvalResult(false);
        return false;
      }
    },
  }));

  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator, { maxConcurrency: 4 });
  const model = createModelFromEnv(process.env, trace);
  const runner = new TurnRunner(model, orchestrator, scheduler, events);
  const runtime = new AgentRuntime(runner, events, store);
  const session = runtime.createSession(process.cwd());

  events.subscribe((event) => ui.handle(event));

  const provider = process.env.MODEL_PROVIDER?.trim().toLowerCase() || "mock";
  ui.banner(provider, process.cwd());
  if (trace) output.write("  ⚠ RAW TRACE ENABLED: prompts, source and tool results saved to .mini-code-agent/logs/raw-trace.jsonl\n\n");

  try {
    while (true) {
      let prompt: string;
      try {
        prompt = await rl.question(ui.prompt());
      } catch {
        // EOF or a closed terminal ends the interactive session.
        break;
      }

      if (prompt.trim().toLowerCase() === "exit") {
        break;
      }
      if (!prompt.trim()) {
        continue;
      }

      const controller = new AbortController();
      const onSigint = () => controller.abort(new Error("user interrupted"));
      rl.on("SIGINT", onSigint);
      process.once("SIGINT", onSigint);

      try {
        const result = await runtime.runTurn(session, prompt, controller.signal);
        // turn.completed / turn.failed / turn.aborted are rendered by TerminalUI.
        if (result.type === "max_steps") ui.maxSteps(result.steps);
      } finally {
        rl.removeListener("SIGINT", onSigint);
        process.removeListener("SIGINT", onSigint);
      }
    }
  } finally {
    rl.close();
    await recorder.flush();
    await trace?.flush();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
