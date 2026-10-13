import type { JsonSchema } from "../contracts/tool";

export type ToolContext = Readonly<{
  cwd: string;
  sessionId: string;
  turnId: string;
  stepId: string;
}>;

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  validate(input: unknown): I;
  execute(input: I, context: ToolContext, signal: AbortSignal): Promise<O>;
  serialize(output: O): string;
}
