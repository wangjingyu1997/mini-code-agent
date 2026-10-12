import type { AgentEvent } from "./event";

export type EventListener = (event: AgentEvent) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
