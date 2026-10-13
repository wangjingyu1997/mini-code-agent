export type JsonSchema = Readonly<Record<string, unknown>>;

export type ToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
}>;

export type ToolCall = Readonly<{
  id: string;
  name: string;
  input: unknown;
}>;
