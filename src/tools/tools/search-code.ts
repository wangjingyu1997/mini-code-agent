import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePathResource } from "../resource";
import type { Tool } from "../tool";

export type SearchCodeInput = Readonly<{ query: string; path: string }>;
export type SearchCodeResult = Readonly<{ matches: readonly string[]; filesScanned: number; truncated: boolean }>;

const IGNORED = new Set([".git", "node_modules", "dist", ".mini-code-agent", "coverage", ".next"]);
const MAX_FILES = 300;
const MAX_RESULTS = 80;
const MAX_FILE_BYTES = 256 * 1024;

function validate(input: unknown): SearchCodeInput {
  if (!input || typeof input !== "object") throw new TypeError("search_code expects {query, path}");
  const value = input as Record<string, unknown>;
  if (typeof value.query !== "string" || value.query.length < 1 || value.query.length > 100) {
    throw new TypeError("query must be 1–100 literal characters");
  }
  if (typeof value.path !== "string" || !["src", "tests"].includes(value.path)) {
    throw new TypeError("path must be src or tests");
  }
  return { query: value.query, path: value.path };
}

/**
 * Small bounded literal code search (not a replacement for ripgrep).
 * No Bash approval necessary: read-only, constrained to src/ or tests/,
 * no symlink traversal, ignored build/dependency folders, bounded output.
 */
export const searchCodeTool: Tool<SearchCodeInput, SearchCodeResult> = {
  name: "search_code",
  description: "Search source code for a literal string across src/ or tests/ once. Returns matching file names and lines; use for import scans instead of repeated list_files/read_file.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Literal substring, e.g. node:" },
      path: { type: "string", enum: ["src", "tests"], description: "Directory to scan" },
    },
    required: ["query", "path"],
    additionalProperties: false,
  },
  validate,
  plan(input, context) {
    return { resources: [{ key: workspacePathResource(context.cwd, input.path), access: "read" }],
      sideEffect: "filesystem", risk: "read" };
  },
  async execute(input, context, signal) {
    const root = await realpath(context.cwd);
    const base = path.join(root, input.path);
    if ((await realpath(base)) !== base) throw new Error("Symlinked search directory denied");
    const files: string[] = [];
    const stack = [base];

    while (stack.length > 0 && files.length < MAX_FILES) {
      if (signal.aborted) throw signal.reason ?? new Error("search_code aborted");
      const directory = stack.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        // Never follow symlink targets, including directories.
        else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)) {
          if (files.length < MAX_FILES) files.push(full);
        }
      }
    }

    const matches: string[] = [];
    let filesScanned = 0;
    let truncated = stack.length > 0;
    for (const file of files.sort()) {
      if (signal.aborted) throw signal.reason ?? new Error("search_code aborted");
      if ((await stat(file)).size > MAX_FILE_BYTES) { truncated = true; continue; }
      const content = await readFile(file, "utf8");
      filesScanned++;
      for (const [index, line] of content.split("\n").entries()) {
        if (!line.includes(input.query)) continue;
        if (matches.length >= MAX_RESULTS) { truncated = true; break; }
        matches.push(path.relative(root, file) + ":" + (index + 1) + ": " + line.slice(0, 200));
      }
      if (matches.length >= MAX_RESULTS) { truncated = true; break; }
    }
    return { matches, filesScanned, truncated };
  },
  serialize(result) {
    return "Scanned " + result.filesScanned + " files; " + result.matches.length +
      " matches" + (result.truncated ? " (result limit reached)" : "") +
      "\n" + result.matches.join("\n");
  },
};
