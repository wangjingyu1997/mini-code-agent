import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent } from "../src/events/event";
import { JsonlEventRecorder, toSafeEventLogRecord } from "../src/events/jsonl-event-recorder";

const base = {
  sessionId: "s-1",
  turnId: "t-1",
  at: 100,
};

test("JSONL recorder persists lifecycle metadata without prompts, code or tool output", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-logs-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "logs", "events.jsonl");
  const recorder = new JsonlEventRecorder(file);
  const secret = "UNIQUE_SUPER_SECRET_DO_NOT_PERSIST";
  const events: AgentEvent[] = [
    { ...base, type: "turn.started", input: secret },
    {
      ...base, type: "model.text.delta", stepId: "step-1", delta: secret,
    },
    {
      ...base, type: "tool.requested", stepId: "step-1",
      callId: "call-1", toolName: "bash", input: { command: secret },
    },
    {
      ...base, type: "tool.started", stepId: "step-1",
      callId: "call-1", toolName: "bash",
      queueWaitMs: 12, queueReason: "resource_conflict",
    },
    {
      ...base, type: "tool.completed", stepId: "step-1",
      callId: "call-1", toolName: "bash",
      output: secret, durationMs: 23,
    },
    {
      ...base, type: "model.failed", stepId: "step-1",
      error: { name: "HttpError", message: secret, stack: secret },
      durationMs: 44,
    },
  ];

  for (const event of events) recorder.record(event);
  await recorder.flush();

  const fileContent = await readFile(file, "utf8");
  assert.doesNotMatch(fileContent, new RegExp(secret));
  const records = fileContent.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(records.length, events.length - 1);
  assert.deepEqual(records.map((record) => record.type), [
    "turn.started", "tool.requested", "tool.started", "tool.completed", "model.failed",
  ]);
  assert.equal(records[0]?.inputChars, secret.length);
  assert.equal(records[2]?.queueWaitMs, 12);
  assert.equal(records[2]?.queueReason, "resource_conflict");
  assert.equal(records[3]?.outputChars, secret.length);
  assert.equal(records[3]?.durationMs, 23);
  assert.equal(records[4]?.errorType, "HttpError");
  assert.equal("input" in records[1]!, false);
  assert.equal("output" in records[3]!, false);
  assert.equal("error" in records[4]!, false);
});

test("safe recorder sanitizes unexpected dynamic names", () => {
  const event: AgentEvent = {
    ...base, type: "tool.requested", stepId: "step-1",
    callId: "call-1", toolName: "KEY=leaked credential", input: {},
  };
  const record = toSafeEventLogRecord(event);
  assert.equal(record?.toolName, "[redacted]");
});

test("JSONL write failures are observable on flush", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mini-agent-logs-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const recorder = new JsonlEventRecorder(cwd); // a directory, not a writable file
  recorder.record({ ...base, type: "turn.completed", answer: "done" });
  await assert.rejects(() => recorder.flush());
});


test("rate-limit retry log stores only timing metadata and never the provider body", () => {
  const event: AgentEvent = {
    ...base, type: "model.rate_limited", stepId: "step-1",
    attempt: 1, maxRetries: 2, waitMs: 1630,
  };
  const record = toSafeEventLogRecord(event);
  assert.equal(record?.type, "model.rate_limited");
  assert.equal(record?.retryAttempt, 1);
  assert.equal(record?.waitMs, 1630);
  assert.equal(record && "message" in record, false);
});
