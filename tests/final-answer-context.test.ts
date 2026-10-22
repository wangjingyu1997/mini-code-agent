import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../src/model/types";
import { buildFinalAnswerContext } from "../src/agent/final-answer-context";

const history: AgentMessage[] = [
  { role: "user", content: "This is an older unrelated turn" },
  { role: "assistant", content: "Earlier answer" },
  { role: "user", content: "List the Node.js APIs imported in src" },
  { role: "assistant_tool_call", callId: "s1", toolName: "search_code",
    input: { path: "src", query: "node:" } },
  { role: "tool", callId: "s1", toolName: "search_code",
    content: 'Scanned 38 files; 27 matches\nsrc/agent/session.ts:1: import { randomUUID } from "node:crypto";',
    isError: false },
  { role: "assistant_tool_call", callId: "r1", toolName: "read_file",
    input: { path: "src/agent/session.ts" } },
  { role: "tool", callId: "r1", toolName: "read_file",
    content: 'import { randomUUID } from "node:crypto";\nexport const id = randomUUID();',
    isError: false },
  { role: "assistant_tool_call", callId: "s2", toolName: "search_code",
    input: { path: "src", query: "node:" } },
  { role: "tool", callId: "s2", toolName: "search_code",
    content: 'Scanned 38 files; 27 matches\nsrc/agent/session.ts:1: import { randomUUID } from "node:crypto";',
    isError: false },
];

test("final answer context is a single text message; no function calls or orphan outputs", () => {
  const result = buildFinalAnswerContext(history, 2000);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
  const text = result.messages[0]?.role === "user" ? result.messages[0].content : "";
  assert.match(text, /List the Node\.js APIs imported in src/);
  assert.match(text, /Scanned 38 files; 27 matches/);
  assert.match(text, /randomUUID/);
  assert.doesNotMatch(text, /Earlier answer|older unrelated turn/);
  assert.equal((text.match(/Scanned 38 files/g) ?? []).length, 1,
    "duplicate search evidence should not be replayed");
});

test("final answer context remains within a small input budget for large file reads", () => {
  const extra: AgentMessage[] = [
    ...history,
    { role: "assistant_tool_call", callId: "r2", toolName: "read_file",
      input: { path: "src/large.ts" } },
    { role: "tool", callId: "r2", toolName: "read_file", content: "Z".repeat(9000), isError: false },
  ];
  const result = buildFinalAnswerContext(extra, 1100);
  assert.ok(result.estimatedTokens <= 1100);
  const text = result.messages[0]?.role === "user" ? result.messages[0].content : "";
  assert.match(text, /Scanned 38 files/);
});

test("final context ignores failed read-only tool calls, treating output as evidence not instructions", () => {
  const result = buildFinalAnswerContext([
    { role: "user", content: "Explain the imports" },
    { role: "assistant_tool_call", callId: "x", toolName: "read_file",
      input: { path: ".env" } },
    { role: "tool", callId: "x", toolName: "read_file",
      content: "access denied", isError: true },
  ], 800);
  assert.equal(result.messages.length, 1);
  const text = result.messages[0]?.role === "user" ? result.messages[0].content : "";
  assert.doesNotMatch(text, /access denied/);
});
