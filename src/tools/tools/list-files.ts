import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { workspacePathResource } from "../resource";
import type { Tool } from "../tool";

export type ListFilesInput = Readonly<{
  path: string;
}>;

export type ListFilesOutput = Readonly<{
  path: string;
  entries: readonly string[];
}>;

function parseInput(input: unknown): ListFilesInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("path" in input) ||
    typeof input.path !== "string"
  ) {
    throw new TypeError("list_files expects { path: string }");
  }

  return { path: input.path || "." };
}

async function resolveInsideWorkspace(cwd: string, requestedPath: string): Promise<string> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, requestedPath);
  const lexicalRelative = path.relative(root, absolute);

  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  const resolved = await realpath(absolute);
  const realRelative = path.relative(root, resolved);

  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Path escapes workspace through symlink: ${requestedPath}`);
  }

  return resolved;
}

export const listFilesTool: Tool<ListFilesInput, ListFilesOutput> = {
  name: "list_files",
  description: "List files and directories inside a workspace directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to the workspace root. Use . for the root." },
    },
    required: ["path"],
    additionalProperties: false,
  },

  validate: parseInput,

  plan(input, context) {
    return {
      resources: [
        {
          key: workspacePathResource(context.cwd, input.path),
          access: "read",
        },
      ],
      sideEffect: "filesystem",
      risk: "read",
    };
  },

  async execute(input, context, signal) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("list_files aborted");
    }

    const absolute = await resolveInsideWorkspace(context.cwd, input.path);
    const dirents = (await readdir(absolute, { withFileTypes: true })) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
    const entries = dirents
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? "[D]" : "[F]"} ${entry.name}`);

    return {
      path: path.relative(context.cwd, absolute) || ".",
      entries,
    };
  },

  serialize(output) {
    return `${output.path}\n---\n${output.entries.join("\n")}`;
  },
};
