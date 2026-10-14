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

export type ResourceAccess = "read" | "write";

export type ResourceClaim = Readonly<{
  key: string;
  access: ResourceAccess;
}>;

export type ExecutionPlan = Readonly<{
  resources: readonly ResourceClaim[];
  sideEffect: "none" | "filesystem" | "process" | "network" | "external";
  risk: "read" | "write" | "destructive";
}>;
