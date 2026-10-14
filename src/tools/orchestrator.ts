import type {
  ExecutionPlan,
  ToolCall,
  ToolDefinition,
} from "../contracts/tool";
import type { EventBus } from "../events/event-bus";
import { serializeError } from "../events/event";
import { conservativeExecutionPlan } from "./resource";
import type { Tool, ToolContext } from "./tool";
import type { ToolRegistry } from "./registry";

export type ToolExecutionResult = Readonly<{
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}>;

export type PreparedToolExecution = Readonly<{
  call: ToolCall;
  plan: ExecutionPlan;
  tool?: Tool<any, any>;
  input?: unknown;
  preparationError?: unknown;
}>;

export class ToolOrchestrator {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly events: EventBus,
  ) {}

  definitions(): readonly ToolDefinition[] {
    return this.registry.definitions();
  }

  prepare(call: ToolCall, context: ToolContext): PreparedToolExecution {
    try {
      const tool = this.registry.get(call.name);
      const input = tool.validate(call.input);
      const plan = tool.plan(input, context);

      return { call, tool, input, plan };
    } catch (error) {
      return {
        call,
        plan: conservativeExecutionPlan,
        preparationError: error,
      };
    }
  }

  async executePrepared(
    prepared: PreparedToolExecution,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Tool execution aborted");
    }

    const { call } = prepared;

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
      if (prepared.preparationError) {
        throw prepared.preparationError;
      }

      if (!prepared.tool) {
        throw new Error(`Tool was not prepared: ${call.name}`);
      }

      const output = await prepared.tool.execute(
        prepared.input,
        context,
        signal,
      );
      const content = prepared.tool.serialize(output);

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

  async execute(
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    return this.executePrepared(this.prepare(call, context), context, signal);
  }
}
