import type { AgentEvent } from "./event";

export class InMemoryEventStore {
  private readonly events: AgentEvent[] = [];

  append(event: AgentEvent): void {
    this.events.push(event);
  }

  all(): readonly AgentEvent[] {
    return [...this.events];
  }

  byTurn(turnId: string): readonly AgentEvent[] {
    return this.events.filter((event) => event.turnId === turnId);
  }
}
