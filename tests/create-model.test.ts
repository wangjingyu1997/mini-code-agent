import assert from "node:assert/strict";
import test from "node:test";
import { createModelFromEnv } from "../src/model/create-model";
import { MockModel } from "../src/model/mock-model";
import { OpenAIResponsesModel } from "../src/model/providers/openai-responses-model";

test("model factory defaults to mock", () => {
  assert.ok(createModelFromEnv({}) instanceof MockModel);
});

test("model factory selects Groq Responses provider", () => {
  const model = createModelFromEnv({
    MODEL_PROVIDER: " groq ",
    GROQ_API_KEY: "test-groq-key",
  });

  assert.ok(model instanceof OpenAIResponsesModel);
});

test("model factory rejects missing Groq API key", () => {
  assert.throws(
    () => createModelFromEnv({ MODEL_PROVIDER: "groq" }),
    /MODEL_PROVIDER=groq requires GROQ_API_KEY/,
  );
});

test("model factory rejects unsupported providers", () => {
  assert.throws(
    () => createModelFromEnv({ MODEL_PROVIDER: "unknown" }),
    /Unsupported MODEL_PROVIDER: unknown/,
  );
});


test("Groq model factory forwards opt-in HTTP trace to the provider", () => {
  const trace = { record(_type: string, _data: unknown) {} };
  const model = createModelFromEnv({
    MODEL_PROVIDER: "groq",
    GROQ_API_KEY: "test-groq-key",
  }, trace);
  assert.equal((model as unknown as { options: { trace?: unknown } }).options.trace, trace);
});
