import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePathResource } from "../resource";
import type { Tool } from "../tool";

/** One literal substring or a bounded batch of literals, without shell access. */
export type SearchCodeInput = Readonly<{
  path: string;
  query: string | readonly string[];
  contextLines?: number | null;
}>;
export type SearchCodeResult = Readonly<{
  matches: readonly string[];
  filesScanned: number;
  truncated: boolean;
}>;

const IGNORED = new Set([".git", "node_modules", "dist", ".mini-code-agent", "coverage", ".next"]);
const MAX_FILES = 300;
const MAX_RESULTS = 80;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_QUERIES = 8;
const MAX_CONTEXT = 2;

function queryList(query: SearchCodeInput["query"]): readonly string[] {
  return typeof query === "string" ? [query] : query;
}

function validate(input: unknown): SearchCodeInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("search_code expects {path, query, contextLines?}");
  }
  const value = input as Record<string, unknown>;
  if (value.path !== "src" && value.path !== "tests") {
    throw new TypeError("path must be src or tests");
  }
  if (!(typeof value.query === "string" || Array.isArray(value.query))) {
    throw new TypeError("query must be a literal string or array of literal strings");
  }
  const queries = typeof value.query === "string" ? [value.query] : value.query as unknown[];
  if (queries.length < 1 || queries.length > MAX_QUERIES ||
      queries.some(q => typeof q !== "string" || q.length < 1 || q.length > 100)) {
    throw new TypeError("query must contain 1–8 nonempty literals of at most 100 characters");
  }
  const context = value.contextLines;
  if (context !== undefined && context !== null &&
      (!Number.isInteger(context) || (context as number) < 0 || (context as number) > MAX_CONTEXT)) {
    throw new TypeError("contextLines must be an integer from 0 to 2");
  }
  return {
    path: value.path as string,
    query: typeof value.query === "string" ? value.query : queries as string[],
    ...(context === undefined || context === null ? {} : { contextLines: context as number }),
  };
}

/**
 * Bounded read-only multi-literal search. No symlinks, no shell commands and
 * no regex; nearby lines give the model usage evidence without N read_file calls.
 */
export const searchCodeTool: Tool<SearchCodeInput, SearchCodeResult> = {
  name: "search_code",
  description: "Search src/ or tests/ for one literal or up to 8 literals in ONE traversal. " +
    "To explain how imported functions are used, batch the import prefix (e.g. node:) " +
    "with method calls (e.g. createHash(, readFile() and request 1–2 contextLines. " +
    "Returns path:line snippets and neighboring source lines. Avoid repeating identical searches.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", enum: ["src", "tests"] },
      query: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 100 },
          { type: "array", items: { type: "string", minLength: 1, maxLength: 100 },
            minItems: 1, maxItems: MAX_QUERIES },
        ],
        description: "One literal or a list of up to 8 literals; all scanned in one pass.",
      },
      contextLines: {
        type: ["integer", "null"], minimum: 0, maximum: MAX_CONTEXT,
        description: "Number of nearby source lines (0 to 2); null means 0. Use 1 or 2 to inspect usage.",
      },
    },
    required: ["path", "query", "contextLines"],
    additionalProperties: false,
  },
  validate,
  plan(input, context) {
    return {
      resources: [{ key: workspacePathResource(context.cwd, input.path), access: "read" }],
      sideEffect: "filesystem", risk: "read",
    };
  },
  async execute(input, context, signal) {
    // execute may also be invoked directly by tests; validate at the boundary.
    const checked = validate(input);
    const queries = queryList(checked.query);
    const around = checked.contextLines ?? 0;
    const root = await realpath(context.cwd);
    const base = path.join(root, checked.path);
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
        // Never follow symlinks, including symlinked directories.
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
      if ((await stat(file)).size > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const relative = path.relative(root, file);
      filesScanned++;

      for (let index = 0; index < lines.length; index++) {
        if (!queries.some(q => lines[index]!.includes(q))) continue;
        if (matches.length >= MAX_RESULTS) { truncated = true; break; }
        const first = Math.max(0, index - around);
        const last = Math.min(lines.length - 1, index + around);
        const excerpt: string[] = [];
        for (let i = first; i <= last; i++) {
          // Colon denotes the matching line, dash denotes context.
          excerpt.push(relative + ":" + (i + 1) + (i === index ? ": " : "-: ") +
            lines[i]!.slice(0, 200));
        }
        matches.push(excerpt.join("\n"));
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
