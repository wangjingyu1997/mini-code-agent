import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../tool";

export type ReadFileInput = Readonly<{
  path: string;
}>;

export type ReadFileOutput = Readonly<{
  path: string;
  content: string;
}>;

function parseInput(input: unknown): ReadFileInput {
  if (
    typeof input !== "object" ||
    input === null ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    input.path.trim() === ""
  ) {
    throw new TypeError("read_file expects { path: string }");
  }

  return { path: input.path };
}

async function resolveInsideWorkspace(cwd: string, requestedPath: string): Promise<string> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, requestedPath);
  const lexicalRelative = path.relative(root, absolute);

  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }

  // Existing paths may still escape through a symlink, so resolve the real target too.
  const resolved = await realpath(absolute);
  const realRelative = path.relative(root, resolved);

  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Path escapes workspace through symlink: ${requestedPath}`);
  }

  return resolved;
}

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
    },
    required: ["path"],
    additionalProperties: false,
  },

  validate: parseInput,

  async execute(input, context, signal) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("read_file aborted");
    }

    const absolute = await resolveInsideWorkspace(context.cwd, input.path);
    const content = await readFile(absolute, "utf8");

    return {
      path: path.relative(context.cwd, absolute),
      content,
    };
  },

  serialize(output) {
    return `${output.path}\n---\n${output.content}`;
  },
};
