import type { EventBus } from "../events/event-bus";
import type { InMemoryEventStore } from "../events/in-memory-event-store";
import { AgentSession } from "./session";
import type { TurnTerminalState } from "./state";
import type { TurnRunner } from "./turn-runner";

export class AgentRuntime {
  constructor(
    private readonly runner: TurnRunner,
    private readonly events: EventBus,
    private readonly eventStore: InMemoryEventStore,
  ) {
    this.events.subscribe((event) => {
      this.eventStore.append(event);
    });
  }

  createSession(cwd: string): AgentSession {
    return new AgentSession({ cwd });
  }

  runTurn(
    session: AgentSession,
    input: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TurnTerminalState> {
    return this.runner.run(session, input, signal);
  }

  getEventStore(): InMemoryEventStore {
    return this.eventStore;
  }
}
