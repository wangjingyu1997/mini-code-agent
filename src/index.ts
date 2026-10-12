import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentRuntime } from "./agent/agent-runtime";
import { TurnRunner } from "./agent/turn-runner";
import { EventBus } from "./events/event-bus";
import { InMemoryEventStore } from "./events/in-memory-event-store";
import { MockModel } from "./model/mock-model";
import { ToolOrchestrator } from "./tools/orchestrator";
import { ToolRegistry } from "./tools/registry";
import { listFilesTool } from "./tools/tools/list-files";
import { readFileTool } from "./tools/tools/read-file";

async function main(): Promise<void> {
  const events = new EventBus();
  const store = new InMemoryEventStore();
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listFilesTool);

  const orchestrator = new ToolOrchestrator(registry, events);
  const runner = new TurnRunner(new MockModel(), orchestrator, events);
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

  const rl = readline.createInterface({ input, output });
  output.write("mini-code-agent v0.1\n输入 exit 退出。\n\n");

  try {
    while (true) {
      const prompt = await rl.question("> ");
      if (prompt.trim().toLowerCase() === "exit") {
        break;
      }

      const controller = new AbortController();
      const onSigint = () => controller.abort(new Error("user interrupted"));
      process.once("SIGINT", onSigint);

      try {
        const result = await runtime.runTurn(session, prompt, controller.signal);
        if (result.type !== "completed") {
          output.write(`\n[turn:${result.type}]\n`);
        } else {
          output.write("\n");
        }
      } finally {
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
