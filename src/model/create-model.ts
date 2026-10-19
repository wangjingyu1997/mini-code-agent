import type { Model } from "./model";
import { MockModel } from "./mock-model";
import { OpenAIResponsesModel } from "./providers/openai-responses-model";

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;

export function createModelFromEnv(env: ModelEnvironment = process.env): Model {
  const provider = env.MODEL_PROVIDER?.trim().toLowerCase() || "mock";

  if (provider === "mock") {
    return new MockModel();
  }

  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    const model = env.OPENAI_MODEL?.trim();

    if (!apiKey) {
      throw new Error("MODEL_PROVIDER=openai requires OPENAI_API_KEY");
    }
    if (!model) {
      throw new Error("MODEL_PROVIDER=openai requires OPENAI_MODEL");
    }

    return new OpenAIResponsesModel({
      apiKey,
      model,
    });
  }

  if (provider === "groq") {
    const apiKey = env.GROQ_API_KEY?.trim();
    const model = env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";

    if (!apiKey) {
      throw new Error("MODEL_PROVIDER=groq requires GROQ_API_KEY");
    }

    return new OpenAIResponsesModel({
      apiKey,
      model,
      baseUrl: "https://api.groq.com/openai/v1",
    });
  }

  throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
}
