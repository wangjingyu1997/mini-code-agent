import type { ModelEvent, ModelRequest } from "./types";

export interface Model {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
