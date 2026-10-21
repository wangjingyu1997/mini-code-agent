import assert from "node:assert/strict";
import test from "node:test";
import { formatDiagnostic } from "../src/events/diagnostics";
import { ToolRegistry } from "../src/tools/registry";
import { readFileTool } from "../src/tools/tools/read-file";

test("terminal diagnostic shows a helpful bounded cause without leaking obvious keys", () => {
  const detail = formatDiagnostic("Provider 429: Bearer test-token \n key=gsk_1234567890ABCDEFGH \n please retry");
  assert.match(detail, /Provider 429/);
  assert.match(detail, /please retry/);
  assert.doesNotMatch(detail, /test-token|gsk_1234567890ABCDEFGH/);
  assert.match(detail, /redacted/);
  assert.equal(formatDiagnostic("x".repeat(1000)).length < 930, true);
});

test("registry returns exact available tool names for a hallucinated namespace", () => {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  assert.throws(
    () => registry.get("repo_browser.list_files"),
    /Unknown tool: repo_browser\.list_files\. Available tools: read_file/,
  );
});
