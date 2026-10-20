import type { ToolCall } from "../contracts/tool";
import type {
  PreparedToolExecution,
  ToolExecutionResult,
  ToolOrchestrator,
} from "./orchestrator";
import { plansConflict } from "./resource";
import type { ToolContext } from "./tool";

export type ToolSchedulerOptions = Readonly<{
  maxConcurrency?: number;
}>;

type ScheduledTask = {
  readonly index: number;
  readonly prepared: PreparedToolExecution;
  state: "queued" | "running" | "completed";
  readonly queuedAt: number;
  queueReason?: "concurrency_limit" | "resource_conflict" | "fifo_fairness";
};

export class ToolScheduler {
  private readonly maxConcurrency: number;

  constructor(
    private readonly orchestrator: ToolOrchestrator,
    options: ToolSchedulerOptions = {},
  ) {
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
  }

  async executeBatch(
    calls: readonly ToolCall[],
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<readonly ToolExecutionResult[]> {
    if (calls.length === 0) {
      return [];
    }

    if (signal.aborted) {
      throw signal.reason ?? new Error("Tool scheduling aborted");
    }

    const tasks: ScheduledTask[] = calls.map((call, index) => ({
      index,
      prepared: this.orchestrator.prepare(call, context),
      state: "queued",
      queuedAt: Date.now(),
    }));

    const results = new Array<ToolExecutionResult>(tasks.length);
    const running = new Set<ScheduledTask>();
    let completed = 0;

    return await new Promise<readonly ToolExecutionResult[]>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };

      const finishWithError = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const finishSuccessfully = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(results);
      };

      const onAbort = () => {
        finishWithError(signal.reason ?? new Error("Tool scheduling aborted"));
      };

      const conflictsWithRunning = (candidate: ScheduledTask): boolean => {
        for (const active of running) {
          if (plansConflict(candidate.prepared.plan, active.prepared.plan)) {
            return true;
          }
        }
        return false;
      };

      const conflictsWithEarlierQueued = (candidate: ScheduledTask): boolean => {
        for (const earlier of tasks) {
          if (earlier.index >= candidate.index) break;
          if (earlier.state !== "queued") continue;

          if (plansConflict(candidate.prepared.plan, earlier.prepared.plan)) {
            return true;
          }
        }
        return false;
      };

      const canStart = (candidate: ScheduledTask): boolean => {
        if (running.size >= this.maxConcurrency) {
          candidate.queueReason = "concurrency_limit";
          return false;
        }
        if (conflictsWithRunning(candidate)) {
          candidate.queueReason = "resource_conflict";
          return false;
        }

        // FIFO fairness per resource: a later task may overtake an earlier queued
        // task only when they do not contend for the same resource.
        if (conflictsWithEarlierQueued(candidate)) {
          candidate.queueReason = "fifo_fairness";
          return false;
        }

        return true;
      };

      const start = (task: ScheduledTask) => {
        task.state = "running";
        running.add(task);

        void this.orchestrator
          .executePrepared(task.prepared, context, signal, {
            queueWaitMs: Date.now() - task.queuedAt,
            ...(task.queueReason ? { queueReason: task.queueReason } : {}),
          })
          .then((result) => {
            if (settled) return;

            results[task.index] = result;
            task.state = "completed";
            running.delete(task);
            completed += 1;

            if (completed === tasks.length) {
              finishSuccessfully();
              return;
            }

            drain();
          })
          .catch((error) => {
            running.delete(task);
            finishWithError(error);
          });
      };

      const drain = () => {
        if (settled || signal.aborted) {
          if (signal.aborted) onAbort();
          return;
        }

        let startedAny = true;
        while (startedAny && running.size < this.maxConcurrency) {
          startedAny = false;

          for (const task of tasks) {
            if (task.state !== "queued") continue;
            if (!canStart(task)) continue;

            start(task);
            startedAny = true;

            if (running.size >= this.maxConcurrency) {
              break;
            }
          }
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      drain();
    });
  }
}
