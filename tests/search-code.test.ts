import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchCodeTool } from "../src/tools/tools/search-code";

test("source search scans imports in src once with path and line number", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  await mkdir(path.join(cwd, "src", "sub"));
  await mkdir(path.join(cwd, "node_modules"));
  await writeFile(path.join(cwd, "src", "a.ts"), 'import { readFile } from "node:fs/promises";\n');
  await writeFile(path.join(cwd, "src", "sub", "b.ts"), 'import { randomUUID } from "node:crypto";\n');
  await writeFile(path.join(cwd, "node_modules", "bad.js"), 'import fs from "node:fs";');
  const context = { cwd, sessionId: "s", turnId: "t", stepId: "x" };
  const result = await searchCodeTool.execute(
    { path: "src", query: "node:" },
    context, new AbortController().signal,
  );
  assert.equal(result.filesScanned, 2);
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.some(m => m.includes("src/a.ts:1")));
  assert.ok(result.matches.some(m => m.includes("src/sub/b.ts:1")));
});

test("source search rejects paths outside src and tests", () => {
  assert.throws(() => searchCodeTool.validate({ query: "API_KEY", path: "." }), /path must be/);
  assert.throws(() => searchCodeTool.validate({ query: "", path: "src" }), /query must be/);
});

test("source search ignores symlinks even when they point outside the workspace", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agent-search-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "private.ts"), 'import x from "node:private";');
  await symlink("../private.ts", path.join(cwd, "src", "alias.ts"));
  const result = await searchCodeTool.execute(
    { query: "node:", path: "src" },
    { cwd, sessionId: "s", turnId: "t", stepId: "x" },
    new AbortController().signal,
  );
  assert.equal(result.matches.length, 0);
});
