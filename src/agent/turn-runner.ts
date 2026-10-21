import { randomUUID } from "node:crypto";
import type { ToolCall } from "../contracts/tool";
import type { EventBus } from "../events/event-bus";
import { serializeError } from "../events/event";
import type { Model } from "../model/model";
import type { ModelEvent } from "../model/types";
import type { ToolOrchestrator } from "../tools/orchestrator";
import type { ToolScheduler } from "../tools/scheduler";
import type { AgentSession } from "./session";
import type { TurnTerminalState } from "./state";

export type TurnRunnerOptions = Readonly<{
  maxSteps?: number;
}>;

export class TurnRunner {
  private readonly maxSteps: number;

  constructor(
    private readonly model: Model,
    private readonly tools: ToolOrchestrator,
    private readonly scheduler: ToolScheduler,
    private readonly events: EventBus,
    options: TurnRunnerOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 20;
  }

  async run(
    session: AgentSession,
    input: string,
    signal: AbortSignal,
  ): Promise<TurnTerminalState> {
    const turnId = randomUUID();
    session.append({ role: "user", content: input });

    await this.events.emit({
      type: "turn.started",
      sessionId: session.id,
      turnId,
      input,
      at: Date.now(),
    });

    try {
      for (let step = 1; step <= this.maxSteps; step += 1) {
        if (signal.aborted) {
          return await this.abort(session, turnId, step - 1, signal);
        }

        const stepId = `${turnId}:${step}`;
        const assistantText: string[] = [];
        const toolCalls: ToolCall[] = [];

        const modelStartedAt = Date.now();
        await this.events.emit({
          type: "model.started",
          sessionId: session.id,
          turnId,
          stepId,
          at: Date.now(),
        });

        try {
          for await (const event of this.model.stream(
            {
              sessionId: session.id,
              turnId,
              stepId,
              messages: [...session.history],
              tools: this.tools.definitions(),
            },
            signal,
          )) {
            this.consumeModelEvent(event, assistantText, toolCalls);
  
            if (event.type === "rate_limit.retry") {
              await this.events.emit({
                type: "model.rate_limited",
                sessionId: session.id,
                turnId,
                stepId,
                attempt: event.attempt,
                maxRetries: event.maxRetries,
                waitMs: event.waitMs,
                at: Date.now(),
              });
            }

            if (event.type === "text.delta") {
              await this.events.emit({
                type: "model.text.delta",
                sessionId: session.id,
                turnId,
                stepId,
                delta: event.text,
                at: Date.now(),
              });
            }
  
            if (event.type === "tool.call") {
              await this.events.emit({
                type: "tool.requested",
                sessionId: session.id,
                turnId,
                stepId,
                callId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
                at: Date.now(),
              });
            }
          }
        } catch (error) {
          await this.events.emit({
            type: "model.failed",
            sessionId: session.id,
            turnId,
            stepId,
            durationMs: Date.now() - modelStartedAt,
            error: serializeError(error),
            at: Date.now(),
          });
          throw error;
        }

        await this.events.emit({
          type: "model.completed",
          sessionId: session.id,
          turnId,
          stepId,
          durationMs: Date.now() - modelStartedAt,
          toolCallCount: toolCalls.length,
          textChars: assistantText.reduce((sum, chunk) => sum + chunk.length, 0),
          at: Date.now(),
        });

        const text = assistantText.join("");
        if (text) {
          session.append({ role: "assistant", content: text });
        }

        for (const call of toolCalls) {
          session.append({
            role: "assistant_tool_call",
            callId: call.id,
            toolName: call.name,
            input: call.input,
          });
        }

        if (toolCalls.length === 0) {
          await this.events.emit({
            type: "turn.completed",
            sessionId: session.id,
            turnId,
            answer: text,
            at: Date.now(),
          });

          return {
            type: "completed",
            answer: text,
            turnId,
            steps: step,
          };
        }

        const results = await this.scheduler.executeBatch(
          toolCalls,
          {
            cwd: session.cwd,
            sessionId: session.id,
            turnId,
            stepId,
          },
          signal,
        );

        if (signal.aborted) {
          return await this.abort(session, turnId, step, signal);
        }

        for (const result of results) {
          session.append({
            role: "tool",
            callId: result.callId,
            toolName: result.toolName,
            content: result.content,
            isError: result.isError,
          });
        }
      }

      return {
        type: "max_steps",
        turnId,
        steps: this.maxSteps,
      };
    } catch (error) {
      if (signal.aborted) {
        return await this.abort(session, turnId, 0, signal);
      }

      const serialized = serializeError(error);
      await this.events.emit({
        type: "turn.failed",
        sessionId: session.id,
        turnId,
        error: serialized,
        at: Date.now(),
      });

      return {
        type: "failed",
        error: serialized,
        turnId,
        steps: 0,
      };
    }
  }

  private consumeModelEvent(
    event: ModelEvent,
    text: string[],
    toolCalls: ToolCall[],
  ): void {
    if (event.type === "text.delta") {
      text.push(event.text);
      return;
    }

    if (event.type === "tool.call") {
      toolCalls.push(event.call);
    }
  }

  private async abort(
    session: AgentSession,
    turnId: string,
    steps: number,
    signal: AbortSignal,
  ): Promise<TurnTerminalState> {
    const reason = signal.reason instanceof Error
      ? signal.reason.message
      : String(signal.reason ?? "aborted");

    await this.events.emit({
      type: "turn.aborted",
      sessionId: session.id,
      turnId,
      reason,
      at: Date.now(),
    });

    return {
      type: "aborted",
      reason,
      turnId,
      steps,
    };
  }
}
