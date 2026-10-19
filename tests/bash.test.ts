import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conservativeExecutionPlan } from "../src/tools/resource";
import { createBashTool } from "../src/tools/tools/bash";

function context(cwd: string) {
  return {
    cwd,
    sessionId: "session-test",
    turnId: "turn-test",
    stepId: "step-test",
  };
}

test("bash requires approval and never runs a denied command", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let approvalCount = 0;

  const tool = createBashTool({
    approve: async ({ command, cwd: requestedCwd }) => {
      approvalCount += 1;
      assert.match(command, /blocked\.txt/);
      assert.equal(requestedCwd, cwd);
      return false;
    },
  });

  await assert.rejects(
    () => tool.execute(
      { command: "printf blocked > blocked.txt" },
      context(cwd),
      new AbortController().signal,
    ),
    /User denied bash command/,
  );

  assert.equal(approvalCount, 1);
  await assert.rejects(readFile(path.join(cwd, "blocked.txt"), "utf8"), /ENOENT/);
  assert.deepEqual(tool.plan({ command: "echo hi" }, context(cwd)), conservativeExecutionPlan);
});

test("bash returns stdout, stderr and a nonzero exit code", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tool = createBashTool({ approve: async () => true });

  const result = await tool.execute(
    { command: "printf hello; printf warning >&2; exit 7" },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.equal(result.timedOut, false);
  assert.equal(result.outputTruncated, false);
  assert.match(tool.serialize(result), /exit_code: 7/);
});

test("bash reports timeout and terminates long-running commands", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tool = createBashTool({ approve: async () => true, timeoutMs: 40 });

  const result = await tool.execute(
    { command: "sleep 5" },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(result.timedOut, true);
});

test("bash truncates excessive output and terminates the command", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tool = createBashTool({ approve: async () => true, maxOutputBytes: 5 });

  const result = await tool.execute(
    { command: "printf 'abcdefghij'" },
    context(cwd),
    new AbortController().signal,
  );

  assert.equal(result.stdout, "abcde");
  assert.equal(result.outputTruncated, true);
});

test("bash abort propagates to the caller and terminates the process", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-bash-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  const tool = createBashTool({ approve: async () => true });

  const pending = tool.execute(
    { command: "sleep 5" },
    context(cwd),
    controller.signal,
  );

  setTimeout(() => controller.abort(new Error("user cancelled")), 40);
  await assert.rejects(pending, /user cancelled/);
});

test("bash checks abort before user approval", async () => {
  let wasAsked = false;
  const tool = createBashTool({
    approve: async () => { wasAsked = true; return true; },
  });
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));

  await assert.rejects(
    () => tool.execute(
      { command: "echo hi" },
      context(process.cwd()),
      controller.signal,
    ),
    /pre-aborted/,
  );
  assert.equal(wasAsked, false);
});
