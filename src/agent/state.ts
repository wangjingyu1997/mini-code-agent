import type { SerializedError } from "../events/event";

export type TurnTerminalState =
  | Readonly<{
      type: "completed";
      answer: string;
      turnId: string;
      steps: number;
    }>
  | Readonly<{
      type: "aborted";
      reason: string;
      turnId: string;
      steps: number;
    }>
  | Readonly<{
      type: "failed";
      error: SerializedError;
      turnId: string;
      steps: number;
    }>
  | Readonly<{
      type: "max_steps";
      turnId: string;
      steps: number;
    }>;
