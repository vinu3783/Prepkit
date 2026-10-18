import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LlmClient, type LlmClientOptions } from "./llm/client.js";
import { LlmError } from "./llm/errors.js";
import { GeminiProvider, GroqProvider, type LlmProvider } from "./llm/providers.js";

/** Load the repo-root .env if present. Real environment variables always win. */
export function loadEnv(): void {
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

export function createLlmClient(options: LlmClientOptions = {}): LlmClient {
  const providers: LlmProvider[] = [];
  const { GROQ_API_KEY, GROQ_MODEL, GROQ_OVERFLOW_MODELS, GEMINI_API_KEY, GEMINI_MODEL } = process.env;
  // Preference order: primary Groq model, extra Groq models (separate per-model limits),
  // then Gemini, whose free tier has a small daily request quota worth saving.
  if (GROQ_API_KEY) {
    providers.push(new GroqProvider(GROQ_API_KEY, GROQ_MODEL || "openai/gpt-oss-120b"));
    const extra = (GROQ_OVERFLOW_MODELS ?? "openai/gpt-oss-20b").split(",").map((m) => m.trim()).filter(Boolean);
    for (const model of extra) if (!providers.some((p) => p.name === `groq:${model}`)) providers.push(new GroqProvider(GROQ_API_KEY, model));
  }
  if (GEMINI_API_KEY) providers.push(new GeminiProvider(GEMINI_API_KEY, GEMINI_MODEL || "gemini-3.5-flash-lite"));
  if (providers.length === 0) {
    throw new LlmError("PROVIDER_CONFIG", "Set GROQ_API_KEY and/or GEMINI_API_KEY (see .env.example)");
  }
  return new LlmClient(providers, options);
}
