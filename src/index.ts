import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentRuntime } from "./agent/agent-runtime";
import { TurnRunner } from "./agent/turn-runner";
import { EventBus } from "./events/event-bus";
import { InMemoryEventStore } from "./events/in-memory-event-store";
import { createModelFromEnv } from "./model/create-model";
import { ToolOrchestrator } from "./tools/orchestrator";
import { ToolRegistry } from "./tools/registry";
import { ToolScheduler } from "./tools/scheduler";
import { applyPatchTool } from "./tools/tools/apply-patch";
import { createBashTool } from "./tools/tools/bash";
import { listFilesTool } from "./tools/tools/list-files";
import { readFileTool } from "./tools/tools/read-file";

async function main(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listFilesTool);
  registry.register(applyPatchTool);
  registry.register(createBashTool({
    approve: async ({ command, cwd }, signal) => {
      output.write("\n[bash approval] Working directory: " + cwd + "\n");
      output.write("[bash approval] Command:\n" + command + "\n");
      try {
        const answer = await rl.question("Allow this command? [y/N] ", { signal });
        return answer.trim().toLowerCase() === "y" ||
          answer.trim().toLowerCase() === "yes";
      } catch {
        return false;
      }
    },
  }));

  const orchestrator = new ToolOrchestrator(registry, events);
  const scheduler = new ToolScheduler(orchestrator, { maxConcurrency: 4 });
  const model = createModelFromEnv();
  const runner = new TurnRunner(model, orchestrator, scheduler, events);
  const runtime = new AgentRuntime(runner, events, store);
  const session = runtime.createSession(process.cwd());

  events.subscribe((event) => {
    if (event.type === "model.text.delta") {
      output.write(event.delta);
    }
    if (event.type === "tool.started") {
      output.write(`\n[tool:start] ${event.toolName}\n`);
    }
    if (event.type === "tool.completed") {
      output.write(`[tool:done] ${event.toolName}\n`);
    }
    if (event.type === "tool.failed") {
      output.write(`[tool:error] ${event.toolName}: ${event.error.message}\n`);
    }
  });

  const provider = process.env.MODEL_PROVIDER?.trim().toLowerCase() || "mock";
  output.write("mini-code-agent v0.4-dev [provider=" + provider + "]\n输入 exit 退出。\n\n");

  try {
    while (true) {
      let prompt: string;
      try {
        prompt = await rl.question("> ");
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
        if (result.type !== "completed") {
          output.write("\n[turn:" + result.type + "]\n");
        } else {
          output.write("\n");
        }
      } finally {
        rl.removeListener("SIGINT", onSigint);
        process.removeListener("SIGINT", onSigint);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
