import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StaleFileError } from "../src/patch/patch-engine";
import { applyPatchTool } from "../src/tools/tools/apply-patch";
import { listFilesTool } from "../src/tools/tools/list-files";
import { readFileTool } from "../src/tools/tools/read-file";

const context = (cwd: string) => ({
  cwd,
  sessionId: "session-test",
  turnId: "turn-test",
  stepId: "step-test",
});

test("read_file reads a file inside the workspace and returns a snapshot hash", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "hello.txt"), "hello agent", "utf8");

  const output = await readFileTool.execute(
    { path: "hello.txt" },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(output.content, "hello agent");
  assert.match(output.hash, /^[a-f0-9]{64}$/);
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

test("apply_patch edits the exact snapshot and returns the new hash", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "hello.txt"), "hello agent\n", "utf8");

  const snapshot = await readFileTool.execute(
    { path: "hello.txt" },
    context(cwd),
    new AbortController().signal,
  );

  const result = await applyPatchTool.execute(
    {
      path: "hello.txt",
      expectedHash: snapshot.hash,
      replacements: [{ oldText: "hello agent", newText: "hello patch engine" }],
    },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(await readFile(path.join(cwd, "hello.txt"), "utf8"), "hello patch engine\n");
  assert.equal(result.beforeHash, snapshot.hash);
  assert.notEqual(result.afterHash, snapshot.hash);
});

test("apply_patch rejects a stale snapshot instead of overwriting external edits", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "hello.txt"), "version one\n", "utf8");

  const snapshot = await readFileTool.execute(
    { path: "hello.txt" },
    context(cwd),
    new AbortController().signal,
  );

  await writeFile(path.join(cwd, "hello.txt"), "user changed this\n", "utf8");

  await assert.rejects(
    () => applyPatchTool.execute(
      {
        path: "hello.txt",
        expectedHash: snapshot.hash,
        replacements: [{ oldText: "version one", newText: "agent edit" }],
      },
      context(cwd),
      new AbortController().signal,
    ),
    StaleFileError,
  );

  assert.equal(await readFile(path.join(cwd, "hello.txt"), "utf8"), "user changed this\n");
});

test("apply_patch rejects ambiguous oldText matches", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-"));
  await writeFile(path.join(cwd, "hello.txt"), "same\nsame\n", "utf8");

  const snapshot = await readFileTool.execute(
    { path: "hello.txt" },
    context(cwd),
    new AbortController().signal,
  );

  await assert.rejects(
    () => applyPatchTool.execute(
      {
        path: "hello.txt",
        expectedHash: snapshot.hash,
        replacements: [{ oldText: "same", newText: "changed" }],
      },
      context(cwd),
      new AbortController().signal,
    ),
    /ambiguous/,
  );
});


test("read_file refuses .env secrets including symlink aliases", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-secret-"));
  await writeFile(path.join(cwd, ".env"), "GROQ_API_KEY=fake-test-secret", "utf8");
  await symlink(".env", path.join(cwd, "innocent.txt"));

  for (const requestedPath of [".env", "innocent.txt"]) {
    await assert.rejects(
      () => readFileTool.execute(
        { path: requestedPath },
        context(cwd),
        new AbortController().signal,
      ),
      /Access to credential file is blocked/,
    );
  }
});
