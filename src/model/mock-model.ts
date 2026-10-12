import { randomUUID } from "node:crypto";
import type { Model } from "./model";
import type {
  AgentMessage,
  ModelEvent,
  ModelRequest,
  ToolMessage,
} from "./types";

function latestUserMessage(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function latestToolMessage(messages: readonly AgentMessage[]): ToolMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "tool") {
      return message;
    }
    if (message?.role === "user") {
      return undefined;
    }
  }
  return undefined;
}

function clip(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export class MockModel implements Model {
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Model invocation aborted");
    }

    const userInput = latestUserMessage(request.messages);
    const toolResult = latestToolMessage(request.messages);

    if (toolResult) {
      if (toolResult.isError) {
        yield {
          type: "text.delta",
          text: `工具 ${toolResult.toolName} 执行失败：${toolResult.content}`,
        };
      } else {
        yield {
          type: "text.delta",
          text: `工具 ${toolResult.toolName} 返回：\n${clip(toolResult.content)}`,
        };
      }
      yield { type: "response.completed" };
      return;
    }

    if (/读取|read/i.test(userInput) && /package\.json/i.test(userInput)) {
      yield { type: "text.delta", text: "我先读取 package.json。\n" };
      yield {
        type: "tool.call",
        call: {
          id: randomUUID(),
          name: "read_file",
          input: { path: "package.json" },
        },
      };
      yield { type: "response.completed" };
      return;
    }

    if (/列出|list/i.test(userInput)) {
      yield { type: "text.delta", text: "我先查看当前工作区。\n" };
      yield {
        type: "tool.call",
        call: {
          id: randomUUID(),
          name: "list_files",
          input: { path: "." },
        },
      };
      yield { type: "response.completed" };
      return;
    }

    yield {
      type: "text.delta",
      text:
        "V0.1 的 MockModel 目前支持两类确定性动作：`读取 package.json` 和 `列出当前目录文件`。",
    };
    yield { type: "response.completed" };
  }
}
