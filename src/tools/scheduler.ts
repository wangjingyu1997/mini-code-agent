import type { ToolCall } from "../contracts/tool";
import type {
  PreparedToolExecution,
  ToolExecutionResult,
  ToolOrchestrator,
} from "./orchestrator";
import { conservativeExecutionPlan, plansConflict } from "./resource";
import { ResourceResolver, type ResourceResolverLike } from "./resource-resolver";
import type { ToolContext } from "./tool";

export type ToolSchedulerOptions = Readonly<{
  maxConcurrency?: number;
  resourceResolver?: ResourceResolverLike;
}>;

type QueueReason = "concurrency_limit" | "resource_conflict" | "fifo_fairness";

type Batch = {
  readonly context: ToolContext;
  readonly signal: AbortSignal;
  readonly results: ToolExecutionResult[];
  readonly resolve: (results: readonly ToolExecutionResult[]) => void;
  readonly reject: (error: unknown) => void;
  onAbort: () => void;
  remaining: number;
  settled: boolean;
};

type ScheduledTask = {
  readonly batch: Batch;
  readonly index: number;
  prepared: PreparedToolExecution;
  readonly queuedAt: number;
  ready: boolean;
  queueReason?: QueueReason;
};

/**
 * Instance-wide admission controller. Every batch submitted to the same
 * scheduler participates in ONE shared queue, resource graph and concurrency
 * limit. This is in-process coordination, NOT an inter-process file lock.
 */
export class ToolScheduler {
  private readonly maxConcurrency: number;
  private readonly resourceResolver: ResourceResolverLike;
  private readonly queued: ScheduledTask[] = [];
  private readonly running = new Set<ScheduledTask>();

  constructor(
    private readonly orchestrator: ToolOrchestrator,
    options: ToolSchedulerOptions = {},
  ) {
    const maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
    this.resourceResolver = options.resourceResolver ?? new ResourceResolver();
  }

  async executeBatch(
    calls: readonly ToolCall[],
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<readonly ToolExecutionResult[]> {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Tool scheduling aborted");
    }
    if (calls.length === 0) {
      return [];
    }

    return new Promise<readonly ToolExecutionResult[]>((resolve, reject) => {
      const batch: Batch = {
        context,
        signal,
        results: new Array<ToolExecutionResult>(calls.length),
        resolve,
        reject,
        remaining: calls.length,
        settled: false,
        onAbort: () => {},
      };

      // Reserve queue positions synchronously before any asynchronous
      // realpath lookup. Unresolved earlier tasks block later tasks from
      // overtaking them until their resource identity is known.
      const tasks: ScheduledTask[] = [];
      for (const [index, call] of calls.entries()) {
        const task: ScheduledTask = {
          batch,
          index,
          prepared: this.orchestrator.prepare(call, context),
          queuedAt: Date.now(),
          ready: false,
        };
        this.queued.push(task);
        tasks.push(task);
      }

      batch.onAbort = () => this.failBatch(
        batch,
        signal.reason ?? new Error("Tool scheduling aborted"),
      );
      signal.addEventListener("abort", batch.onAbort, { once: true });

      // Covers a signal aborted while prepare() was executing.
      if (signal.aborted) {
        batch.onAbort();
      } else {
        for (const task of tasks) {
          void this.resolveTask(task);
        }
        this.drain();
      }
    });
  }

  private async resolveTask(task: ScheduledTask): Promise<void> {
    try {
      const plan = await this.resourceResolver.resolve(task.prepared.plan);
      if (task.batch.settled) return;
      task.prepared = { ...task.prepared, plan };
    } catch (error) {
      if (task.batch.settled) return;
      // Never execute a tool using an unverified path resource identity.
      // Still return a normal isError tool result to the Agent Model.
      task.prepared = {
        call: task.prepared.call,
        plan: conservativeExecutionPlan,
        preparationError: error,
      };
    }

    task.ready = true;
    this.drain();
  }

  private dropQueuedTasks(batch: Batch): void {
    // Only queued tasks are removed. Already-started tasks retain their
    // resource claims until the real execution Promise settles.
    for (let i = this.queued.length - 1; i >= 0; i -= 1) {
      if (this.queued[i]!.batch === batch) {
        this.queued.splice(i, 1);
      }
    }
  }

  private failBatch(batch: Batch, error: unknown): void {
    if (batch.settled) return;
    batch.settled = true;
    batch.signal.removeEventListener("abort", batch.onAbort);
    this.dropQueuedTasks(batch);
    batch.reject(error);
    this.drain();
  }

  private finishBatch(batch: Batch): void {
    if (batch.settled) return;
    batch.settled = true;
    batch.signal.removeEventListener("abort", batch.onAbort);
    batch.resolve(batch.results);
  }

  private conflictsWithRunning(candidate: ScheduledTask): boolean {
    for (const active of this.running) {
      if (plansConflict(candidate.prepared.plan, active.prepared.plan)) {
        return true;
      }
    }
    return false;
  }

  private conflictsWithEarlierQueued(index: number): boolean {
    const candidate = this.queued[index]!;
    for (let i = 0; i < index; i += 1) {
      const earlier = this.queued[i]!;
      // A resource identity still being resolved may conflict with ANY
      // later task; do not let async completion order violate FIFO.
      if (!earlier.ready) return true;
      if (plansConflict(candidate.prepared.plan, earlier.prepared.plan)) {
        return true;
      }
    }
    return false;
  }

  private canStart(index: number): boolean {
    const candidate = this.queued[index]!;
    if (!candidate.ready) return false;
    if (this.running.size >= this.maxConcurrency) {
      candidate.queueReason = "concurrency_limit";
      return false;
    }
    if (this.conflictsWithRunning(candidate)) {
      candidate.queueReason = "resource_conflict";
      return false;
    }
    if (this.conflictsWithEarlierQueued(index)) {
      candidate.queueReason = "fifo_fairness";
      return false;
    }
    return true;
  }

  private start(task: ScheduledTask): void {
    this.running.add(task);

    // Do not race the orchestration promise with AbortSignal: a timeout or
    // cancellation must not release the lock while a noncooperative write
    // is still in flight. The batch Promise can reject immediately instead.
    void this.orchestrator.executePrepared(
      task.prepared,
      task.batch.context,
      task.batch.signal,
      {
        queueWaitMs: Date.now() - task.queuedAt,
        ...(task.queueReason ? { queueReason: task.queueReason } : {}),
      },
    ).then((result) => {
      this.running.delete(task);
      const batch = task.batch;
      if (!batch.settled) {
        batch.results[task.index] = result;
        batch.remaining -= 1;
        if (batch.remaining === 0) this.finishBatch(batch);
      }
      this.drain();
    }).catch((error: unknown) => {
      this.running.delete(task);
      this.failBatch(task.batch, error);
      this.drain();
    });
  }

  private drain(): void {
    // A blocked task does not prevent independent later work from starting.
    // Conflicting later tasks may not overtake an earlier queued task.
    let i = 0;
    while (i < this.queued.length && this.running.size < this.maxConcurrency) {
      if (!this.canStart(i)) {
        i += 1;
        continue;
      }
      const [task] = this.queued.splice(i, 1);
      this.start(task!);
    }

    // Preserve the observability metric even when the concurrency cap is full.
    for (; i < this.queued.length; i += 1) {
      this.queued[i]!.queueReason = "concurrency_limit";
    }
  }
}
