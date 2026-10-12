import type { EventBus } from "../events/event-bus";
import { serializeError } from "../events/event";
import type { ToolCall } from "../model/types";
import type { ToolContext } from "./tool";
import type { ToolRegistry } from "./registry";

export type ToolExecutionResult = Readonly<{
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}>;

export class ToolOrchestrator {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly events: EventBus,
  ) {}

  async execute(
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Tool execution aborted");
    }

    await this.events.emit({
      type: "tool.started",
      sessionId: context.sessionId,
      turnId: context.turnId,
      stepId: context.stepId,
      callId: call.id,
      toolName: call.name,
      at: Date.now(),
    });

    try {
      const tool = this.registry.get(call.name);
      const input = tool.validate(call.input);
      const output = await tool.execute(input, context, signal);
      const content = tool.serialize(output);

      await this.events.emit({
        type: "tool.completed",
        sessionId: context.sessionId,
        turnId: context.turnId,
        stepId: context.stepId,
        callId: call.id,
        toolName: call.name,
        output: content,
        at: Date.now(),
      });

      return {
        callId: call.id,
        toolName: call.name,
        content,
        isError: false,
      };
    } catch (error) {
      const serialized = serializeError(error);

      await this.events.emit({
        type: "tool.failed",
        sessionId: context.sessionId,
        turnId: context.turnId,
        stepId: context.stepId,
        callId: call.id,
        toolName: call.name,
        error: serialized,
        at: Date.now(),
      });

      return {
        callId: call.id,
        toolName: call.name,
        content: `${serialized.name}: ${serialized.message}`,
        isError: true,
      };
    }
  }
}
