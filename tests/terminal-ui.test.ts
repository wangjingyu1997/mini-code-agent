import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../src/events/event";
import { safeTerminalText, TerminalUI } from "../src/cli/terminal-ui";

function setup(options: { color?: boolean; isTTY?: boolean; env?: Record<string, string | undefined> } = {}) {
  const chunks: string[] = [];
  const out = {
    isTTY: options.isTTY ?? false,
    columns: 80,
    write(text: string) { chunks.push(text); return true; },
  };
  const ui = new TerminalUI(out, {
    ...(options.color === undefined ? {} : { color: options.color }),
    env: options.env ?? {},
  });
  return { ui, output: () => chunks.join("") };
}

const base = { sessionId: "s", turnId: "t", at: 0 };

test("TTY uses distinct colored statuses and highlights permission prompts", () => {
  const { ui, output } = setup({ isTTY: true });
  ui.banner("groq", "/tmp/repo");
  ui.handle({ ...base, type: "model.started", stepId: "t:1" });
  ui.handle({ ...base, type: "tool.started", stepId: "t:1",
    callId: "call-1", toolName: "bash", queueWaitMs: 16, queueReason: "resource_conflict" });
  ui.handle({ ...base, type: "tool.completed", stepId: "t:1",
    callId: "call-1", toolName: "bash", durationMs: 120, output: "ok" });
  ui.approvalRequest("git status", "/tmp/repo");
  ui.approvalResult(true);
  ui.handle({ ...base, type: "turn.completed", answer: "done" });
  assert.match(output(), /\u001b\[36m/); // cyan activity
  assert.match(output(), /\u001b\[32m/); // green successful completion
  assert.match(output(), /\u001b\[33m/); // yellow approval
  assert.match(output(), /Permission required/);
  assert.match(output(), /git status/);
  assert.match(output(), /queued 16ms \(resource_conflict\)/);
  assert.match(output(), /Permission granted/);
  assert.match(output(), /Completed/);
});

test("non-TTY output contains no ANSI and keeps status words", () => {
  const { ui, output } = setup({ isTTY: false });
  ui.banner("mock", "/project");
  ui.handle({ ...base, type: "tool.failed", stepId: "t:1",
    callId: "c", toolName: "read_file", durationMs: 5,
    error: { name: "Error", message: "ENOENT" } });
  ui.approvalResult(false);
  assert.doesNotMatch(output(), /\u001b\[/);
  assert.match(output(), /TOOL ERROR/);
  assert.match(output(), /ENOENT/);
  assert.match(output(), /Permission denied/);
});

test("NO_COLOR disables color even on TTY; FORCE_COLOR enables color on pipes", () => {
  const a = setup({ isTTY: true, env: { NO_COLOR: "1" } });
  a.ui.banner("mock", "/project");
  assert.doesNotMatch(a.output(), /\u001b\[/);
  const b = setup({ env: { FORCE_COLOR: "1" } });
  b.ui.banner("mock", "/project");
  assert.match(b.output(), /\u001b\[36m/);
  const c = setup({ env: { TERM: "dumb", FORCE_COLOR: "1" } });
  c.ui.banner("mock", "/project");
  assert.doesNotMatch(c.output(), /\u001b\[/);
});

test("untrusted terminal sequences are stripped from command, path and model text", () => {
  const { ui, output } = setup({ color: false });
  const malicious = "\u001b[2J\u001b]52;c;Y3JlZA==\u0007";
  ui.approvalRequest("echo " + malicious + "safe", "/tmp/\u001b[31mpath");
  const delta: AgentEvent = { ...base, type: "model.text.delta",
    stepId: "t:1", delta: "hello " + malicious + "world" };
  ui.handle(delta);
  ui.handle({ ...base, type: "model.completed", stepId: "t:1", durationMs: 1, toolCallCount: 0, textChars: 11 });
  assert.doesNotMatch(output(), /\u001b|\u0007/);
  assert.doesNotMatch(output(), /Y3JlZA==|\[2J|\[31m/);
  assert.match(output(), /echo safe/);
  assert.match(output(), /hello world/);
  assert.match(output(), /\/tmp\/path/);
  assert.equal(safeTerminalText("a\u0008b\tc\n"), "ab\tc\n");
});

test("streaming assistant output closes the line before tool statuses without duplicates", () => {
  const { ui, output } = setup({ color: false });
  ui.handle({ ...base, type: "model.text.delta", stepId: "t:1", delta: "Hello" });
  ui.handle({ ...base, type: "model.text.delta", stepId: "t:1", delta: " world" });
  ui.handle({ ...base, type: "model.completed", stepId: "t:1", durationMs: 5, toolCallCount: 1, textChars: 11 });
  ui.handle({ ...base, type: "tool.started", stepId: "t:1",
    callId: "a", toolName: "read_file", queueWaitMs: 0 });
  const s = output();
  assert.equal((s.match(/◆ Assistant/g) ?? []).length, 1);
  assert.match(s, /Hello world\n↳ 1 tool request/);
  assert.match(s, /↳ RUN\s+read_file/);
});

test("model failure prints useful diagnostic once and turn failure does not repeat details", () => {
  const { ui, output } = setup({ color: false });
  ui.handle({ ...base, type: "turn.started", input: "test" });
  ui.handle({ ...base, type: "model.failed", stepId: "t:3", durationMs: 556,
    error: { name: "Error", message: "context_length_exceeded" } });
  ui.handle({ ...base, type: "turn.failed",
    error: { name: "Error", message: "context_length_exceeded" } });
  assert.equal((output().match(/context_length_exceeded/g) ?? []).length, 1);
  assert.match(output(), /Model request failed/);
  assert.match(output(), /Turn stopped/);
});

test("turn abort and max steps have distinct warnings", () => {
  const { ui, output } = setup({ color: false });
  ui.handle({ ...base, type: "turn.aborted", reason: "user interrupted" });
  ui.maxSteps(20);
  assert.match(output(), /Interrupted/);
  assert.match(output(), /Reached step limit \(20\)/);
});
