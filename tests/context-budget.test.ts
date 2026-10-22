import assert from "node:assert/strict";
import test from "node:test";
import { buildContext, boundToolOutput, estimateTokens } from "../src/agent/context-budget";
import type { AgentMessage } from "../src/model/types";

const history: AgentMessage[] = [
  { role: "user", content: "Search imports in src" },
  { role: "assistant", content: "Looking into src..." },
  { role: "assistant_tool_call", callId: "call-1", toolName: "list_files", input: { path: "src" } },
  { role: "tool", callId: "call-1", toolName: "list_files", content: "A".repeat(12000), isError: false },
  { role: "assistant_tool_call", callId: "call-2", toolName: "read_file", input: { path: "src/index.ts" } },
  { role: "tool", callId: "call-2", toolName: "read_file", content: "B".repeat(9000), isError: false },
];

test("tool output budget includes explicit truncation marker", () => {
  const bounded = boundToolOutput("hello".repeat(1000), 500);
  assert.equal(bounded.length <= 500, true);
  assert.match(bounded, /output truncated/);
  assert.match(bounded, /^hello/);
});

test("compaction never forwards a tool result without matching call", () => {
  const result = buildContext(history, { maxEstimatedTokens: 800, maxToolOutputChars: 500 });
  const calls = result.messages.filter(m => m.role === "assistant_tool_call");
  const outputs = result.messages.filter(m => m.role === "tool");
  const ids = new Set(calls.map(c => c.role === "assistant_tool_call" ? c.callId : "?"));
  assert.equal(calls.length, outputs.length);
  for (const m of outputs) {
    if (m.role === "tool") assert.ok(ids.has(m.callId));
  }
  assert.ok(result.compacted);
  assert.ok(result.messages.some(m => m.role === "user" && m.content === "Search imports in src"));
});

test("short conversations stay in order without compaction", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant_tool_call", callId: "a", toolName: "read_file", input: { path: "a" } },
    { role: "tool", callId: "a", toolName: "read_file", content: "file text", isError: false },
  ];
  const result = buildContext(messages);
  assert.deepEqual(result.messages, messages);
  assert.equal(result.droppedMessages, 0);
  assert.equal(result.compacted, false);
});

test("token estimate includes the advertised tool schemas", () => {
  const a = buildContext([{ role: "user", content: "hello" }]);
  const b = buildContext([{ role: "user", content: "hello" }], {}, [
    { name: "long_tool", description: "x".repeat(1000) },
  ]);
  assert.ok(b.estimatedTokens > a.estimatedTokens);
  assert.ok(estimateTokens("abc") > 0);
});
