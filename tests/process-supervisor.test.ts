import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProcessSupervisor } from "../src/tools/process-supervisor";

const unixOnly = process.platform === "win32" ? { skip: "Unix process-group semantics" } : {};

async function fixture(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-supervisor-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForFile(file: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await exists(file)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for file: " + file);
}

test("supervisor preserves exit code, stdout and stderr for ordinary foreground command", async (t) => {
  const cwd = await fixture(t);
  const supervisor = new ProcessSupervisor({ timeoutMs: 5000 });
  const result = await supervisor.run({
    command: "printf hello; printf error >&2; exit 7",
    cwd,
    env: process.env,
    signal: new AbortController().signal,
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "error");
  assert.equal(result.outputTruncated, false);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs >= 0);
});

test("supervisor does not hang on quiet inherited stdout after shell exits", unixOnly, async (t) => {
  const cwd = await fixture(t);
  const supervisor = new ProcessSupervisor({
    timeoutMs: 5000,
    postExitIdleMs: 70,
  });
  const start = Date.now();
  const result = await supervisor.run({
    command: "sleep 3 &",
    cwd, env: process.env, signal: new AbortController().signal,
  });
  const elapsed = Date.now() - start;

  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 1500, "must not wait for background sleep to close inherited stdout: " + elapsed);
});

test("foreground tool cleans up same-process-group background writers on normal shell exit", unixOnly, async (t) => {
  const cwd = await fixture(t);
  const supervisor = new ProcessSupervisor({
    timeoutMs: 5000,
    postExitIdleMs: 60,
  });
  const result = await supervisor.run({
    command: "(sleep 0.4; printf late > late.txt) >/dev/null 2>&1 &",
    cwd, env: process.env, signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  assert.equal(await exists(path.join(cwd, "late.txt")), false,
    "background process must not silently modify workspace after foreground result");
});

test("aborted tool escalates from SIGTERM to SIGKILL when command ignores SIGTERM", unixOnly, async (t) => {
  const cwd = await fixture(t);
  const controller = new AbortController();
  const supervisor = new ProcessSupervisor({
    timeoutMs: 5000,
    terminationGraceMs: 80,
  });
  const pending = supervisor.run({
    command: "trap '' TERM; printf started > ready.txt; while :; do sleep 0.05; done",
    cwd, env: process.env, signal: controller.signal,
  });
  await waitForFile(path.join(cwd, "ready.txt"));
  const at = Date.now();
  controller.abort(new Error("test requested stop"));
  await assert.rejects(pending, /test requested stop/);
  assert.ok(Date.now() - at < 1800, "ignoring SIGTERM must not hang cancellation");
});

test("SIGKILL escalation survives a shell close while a child ignores SIGTERM", unixOnly, async (t) => {
  const cwd = await fixture(t);
  const controller = new AbortController();
  const supervisor = new ProcessSupervisor({
    timeoutMs: 5000,
    terminationGraceMs: 80,
    postExitIdleMs: 50,
  });

  const pending = supervisor.run({
    command: "(trap '' TERM; sleep 0.5; printf late > late.txt) >/dev/null 2>&1 & printf ready > ready.txt; wait",
    cwd, env: process.env, signal: controller.signal,
  });
  await waitForFile(path.join(cwd, "ready.txt"));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  controller.abort(new Error("stop process group"));
  await assert.rejects(pending, /stop process group/);

  await new Promise<void>((resolve) => setTimeout(resolve, 700));
  assert.equal(await exists(path.join(cwd, "late.txt")), false,
    "SIGTERM-resistant descendants in the same process group must be killed");
});

test("process supervisor rejects already-aborted execution before spawning", async (t) => {
  const cwd = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const supervisor = new ProcessSupervisor();
  await assert.rejects(
    supervisor.run({
      command: "printf unexpected > unwanted.txt",
      cwd, env: process.env, signal: controller.signal,
    }),
    /already cancelled/,
  );
  assert.equal(await exists(path.join(cwd, "unwanted.txt")), false);
});

test("supervisor enforces output cap and terminates oversized command", async (t) => {
  const cwd = await fixture(t);
  const supervisor = new ProcessSupervisor({ maxOutputBytes: 4, timeoutMs: 5000 });
  const result = await supervisor.run({
    command: "printf 1234567890",
    cwd, env: process.env, signal: new AbortController().signal,
  });
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, "1234");
});
