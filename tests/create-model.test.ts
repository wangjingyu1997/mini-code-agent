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
