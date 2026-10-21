import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessSessionManager } from "../src/tools/process-session-manager";

async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-session-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for " + message);
}

test("start returns a session ID before the process completes, and read uses incremental cursors", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager();
  t.after(() => manager.closeAll());
  const startedAt = Date.now();
  const session = await manager.start({
    cwd,
    env: process.env,
    command: "printf hello; sleep 0.3; printf world >&2",
  });

  assert.ok(session.id);
  assert.equal(session.status, "running");
  assert.ok(Date.now() - startedAt < 250, "start must not wait for command completion");

  await waitFor(
    () => manager.read(session.id, 0).entries.some((item) => item.text.includes("hello")),
    "first stdout chunk",
  );
  const first = manager.read(session.id, 0);
  assert.ok(first.entries.some((x) => x.stream === "stdout" && x.text.includes("hello")));
  assert.equal(manager.read(session.id, first.nextSequence).entries.length, 0);

  await waitFor(
    () => manager.get(session.id).status === "exited",
    "shell exit",
  );
  const rest = manager.read(session.id, first.nextSequence);
  assert.ok(rest.entries.some((x) => x.stream === "stderr" && x.text.includes("world")));
  assert.equal(manager.get(session.id).exitCode, 0);
  assert.equal(rest.nextSequence, manager.read(session.id, 0).nextSequence);
});

test("bounded output history reports cursor truncation while retaining newest records", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager({ maxBufferedChunks: 2, maxChunkBytes: 8 });
  t.after(() => manager.closeAll());
  const session = await manager.start({
    cwd, env: process.env, command: "printf 'abcdefghijklmnopqrstuvwxyz'; sleep 0.1",
  });
  await waitFor(() => manager.get(session.id).status === "exited", "shell exit");
  const out = manager.read(session.id, 0);
  assert.equal(out.truncated, true);
  assert.equal(out.entries.length, 2);
  assert.ok(out.entries[0]!.sequence > 0);
  assert.match(out.entries.map((event) => event.text).join(""), /stuvwxyz/);
});

test("terminate escalates to SIGKILL for a process ignoring SIGTERM", {
  skip: process.platform === "win32" ? "Unix signals required" : false,
}, async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager({ terminationGraceMs: 80 });
  t.after(() => manager.closeAll());
  const session = await manager.start({
    cwd, env: process.env,
    command: "trap '' TERM; printf ready; while :; do sleep 0.1; done",
  });
  await waitFor(() => manager.read(session.id, 0).entries.some((x) => x.text.includes("ready")), "ready");
  const at = Date.now();
  const stopped = await manager.terminate(session.id);
  assert.equal(stopped.status, "exited");
  assert.equal(stopped.stopRequested, true);
  assert.ok(Date.now() - at < 1800);
  assert.equal(manager.get(session.id).status, "exited");
});

test("terminating the direct shell also cleans same-group background writers", {
  skip: process.platform === "win32" ? "Unix process groups required" : false,
}, async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager({ postExitIdleMs: 50 });
  t.after(() => manager.closeAll());
  const session = await manager.start({
    cwd, env: process.env,
    command: "(sleep 0.4; printf leaked > late.txt) >/dev/null 2>&1 &",
  });
  await waitFor(() => manager.get(session.id).status === "exited", "shell exit");
  await new Promise<void>((resolve) => setTimeout(resolve, 600));
  await assert.rejects(stat(path.join(cwd, "late.txt")), /ENOENT/);
});

test("closeAll terminates every managed process and clears its registry", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager({ terminationGraceMs: 80 });
  const first = await manager.start({ cwd, env: process.env, command: "sleep 5" });
  const second = await manager.start({ cwd, env: process.env, command: "sleep 5" });
  assert.equal(manager.list().length, 2);

  await manager.closeAll();
  assert.equal(manager.list().length, 0);
  assert.throws(() => manager.get(first.id), /Unknown process session/);
  assert.throws(() => manager.get(second.id), /Unknown process session/);
  await assert.rejects(
    manager.start({ cwd, env: process.env, command: "printf no" }),
    /closed/,
  );
});

test("invalid cwd fails startup without registering a broken session", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager();
  t.after(() => manager.closeAll());
  await assert.rejects(
    manager.start({ cwd: path.join(cwd, "missing"), env: process.env, command: "echo hi" }),
  );
  assert.equal(manager.list().length, 0);
});

test("an exited session may be read again until explicitly forgotten", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager();
  t.after(() => manager.closeAll());
  const session = await manager.start({ cwd, env: process.env, command: "printf final" });
  await waitFor(() => manager.get(session.id).status === "exited", "shell exit");
  assert.match(manager.read(session.id, 0).entries.map((x) => x.text).join(""), /final/);
  manager.forget(session.id);
  assert.throws(() => manager.get(session.id), /Unknown process session/);
});

test("running sessions cannot be forgotten without termination", async (t) => {
  const cwd = await workspace(t);
  const manager = new ProcessSessionManager();
  t.after(() => manager.closeAll());
  const session = await manager.start({ cwd, env: process.env, command: "sleep 5" });
  assert.throws(() => manager.forget(session.id), /still running/);
});
