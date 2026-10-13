import type { ToolDefinition } from "../contracts/tool";
import type { Tool } from "./tool";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any, any>>();

  register<I, O>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any, any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool;
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  names(): readonly string[] {
    return [...this.tools.keys()];
  }
}
