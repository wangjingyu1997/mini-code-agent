import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../model/types";

export class AgentSession {
  readonly id: string;
  readonly cwd: string;
  readonly history: AgentMessage[] = [];

  constructor(options: { id?: string; cwd: string }) {
    this.id = options.id ?? randomUUID();
    this.cwd = options.cwd;
  }

  append(...messages: AgentMessage[]): void {
    this.history.push(...messages);
  }
}
