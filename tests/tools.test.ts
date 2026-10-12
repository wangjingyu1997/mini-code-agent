import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listFilesTool } from "../src/tools/tools/list-files";
import { readFileTool } from "../src/tools/tools/read-file";

const context = (cwd: string) => ({
  cwd,
  sessionId: "session-test",
  turnId: "turn-test",
  stepId: "step-test",
});

test("read_file reads a file inside the workspace", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "hello.txt"), "hello agent", "utf8");

  const output = await readFileTool.execute(
    { path: "hello.txt" },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(output.content, "hello agent");
});

test("read_file rejects paths outside the workspace", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));

  await assert.rejects(
    () => readFileTool.execute(
      { path: "../outside.txt" },
      context(cwd),
      new AbortController().signal,
    ),
    /escapes workspace/,
  );
});

test("list_files returns deterministic sorted entries", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "b.txt"), "b", "utf8");
  await writeFile(path.join(cwd, "a.txt"), "a", "utf8");

  const output = await listFilesTool.execute(
    { path: "." },
    context(cwd),
    new AbortController().signal,
  );

  assert.deepEqual(output.entries, ["[F] a.txt", "[F] b.txt"]);
});
