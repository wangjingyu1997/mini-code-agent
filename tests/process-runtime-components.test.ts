import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessController } from "../src/tools/process-controller";
import { ProcessOutputBuffer } from "../src/tools/process-output-buffer";

test("output buffer preserves multi-byte UTF-8 characters split across chunks", () => {
  const output = new ProcessOutputBuffer({ maxBufferedChunks: 8, maxChunkBytes: 2 });
  const bytes = Buffer.from("你好🌍");
  for (let i = 0; i < bytes.length; i++) {
    assert.equal(output.append("stdout", bytes.subarray(i, i + 1)), false);
  }
  output.finish();
  assert.equal(output.read(0).entries.map((e) => e.text).join(""), "你好🌍");
});

test("stdout and stderr decoding state is independent", () => {
  const output = new ProcessOutputBuffer({ maxBufferedChunks: 5, maxChunkBytes: 2 });
  const utf8 = Buffer.from("中");
  output.append("stdout", utf8.subarray(0, 1));
  output.append("stderr", Buffer.from("ERR"));
  output.append("stdout", utf8.subarray(1));
  output.finish();
  assert.deepEqual(output.read().entries.map((e) => [e.stream, e.text]), [
    ["stderr", "ER"],
    ["stderr", "R"],
    ["stdout", "中"],
  ]);
});

test("byte-capped output uses one global limit for both streams and reports overflow once", () => {
  const output = new ProcessOutputBuffer({ maxOutputBytes: 5 });
  assert.equal(output.append("stderr", Buffer.from("abc")), false);
  assert.equal(output.append("stdout", Buffer.from("defgh")), true);
  assert.equal(output.append("stdout", Buffer.from("extra")), false);
  output.finish();
  output.finish();
  assert.deepEqual(output.capture(), {
    stdout: "de",
    stderr: "abc",
    outputTruncated: true,
  });
});

test("incremental output cursor reports evicted records but not repeated new output", () => {
  const output = new ProcessOutputBuffer({ maxBufferedChunks: 2, maxChunkBytes: 4 });
  output.append("stdout", Buffer.from("abcdefghij"));
  const first = output.read(0);
  assert.deepEqual(first.entries.map((e) => e.text), ["efgh", "ij"]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextSequence, 3);
  assert.deepEqual(output.read(first.nextSequence), {
    entries: [],
    nextSequence: 3,
    truncated: false,
  });
});

test("controller separates successful spawn acknowledgement from eventual exit", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-controller-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new ProcessController({
    command: "sleep 0.15; printf done",
    cwd, env: process.env,
  });
  await controller.started;
  assert.ok(controller.pid !== undefined);
  const exit = await controller.finished;
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.error, undefined);
  assert.equal(exit.stopRequested, false);
});

test("controller's failed spawn settles finished and rejects started", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-controller-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new ProcessController({
    command: "printf never",
    cwd: path.join(cwd, "missing"),
    env: process.env,
  });
  await assert.rejects(controller.started);
  const exit = await controller.finished;
  assert.ok(exit.error instanceof Error);
  assert.ok(exit.durationMs >= 0);
});

test("requestStop is idempotent and controller reports one terminal outcome", {
  skip: process.platform === "win32" ? "Unix process-group cancellation" : false,
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-controller-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new ProcessController({
    command: "trap '' TERM; while :; do sleep 0.05; done",
    cwd, env: process.env, terminationGraceMs: 50,
  });
  await controller.started;
  controller.requestStop();
  controller.requestStop();
  const exit = await controller.finished;
  assert.equal(exit.stopRequested, true);
  controller.requestStop();
});
