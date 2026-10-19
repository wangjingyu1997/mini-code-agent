import { realpath } from "node:fs/promises";
import path from "node:path";
import { snapshotFile } from "../../patch/patch-engine";
import { workspacePathResource } from "../resource";
import type { Tool } from "../tool";

export type ReadFileInput = Readonly<{
  path: string;
}>;

export type ReadFileOutput = Readonly<{
  path: string;
  content: string;
  hash: string;
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

async function assertLexicallyInsideWorkspace(cwd: string, requestedPath: string): Promise<void> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, requestedPath);
  const relative = path.relative(root, absolute);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${requestedPath}`);
  }
}

// Avoid sending common credentials to a remote model by accident.
// This is a baseline protection, not a complete secret scanner.
function assertNotCredentialFile(requestedPath: string): void {
  const base = path.basename(requestedPath).toLowerCase();
  if (
    base === ".env" ||
    (base.startsWith(".env.") && base !== ".env.example") ||
    [".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519"].includes(base)
  ) {
    throw new Error("Access to credential file is blocked: " + requestedPath);
  }
}

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the current workspace and return a snapshot hash for safe later edits.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
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
      throw signal.reason ?? new Error("read_file aborted");
    }

    // Keep the fast lexical check here so malformed paths fail before any
    // snapshot work; snapshotFile performs the realpath/symlink boundary check.
    assertNotCredentialFile(input.path);
    await assertLexicallyInsideWorkspace(context.cwd, input.path);
    // Check both the requested name and resolved target to prevent a symlink
    // with an innocuous name from revealing a known credential file.
    const resolvedTarget = await realpath(path.resolve(context.cwd, input.path));
    assertNotCredentialFile(resolvedTarget);
    return snapshotFile(context.cwd, input.path);
  },

  serialize(output) {
    return `${output.path}\nsha256:${output.hash}\n---\n${output.content}`;
  },
};
