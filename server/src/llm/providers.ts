import { ProviderHttpError } from "./errors.js";

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}

export interface CompletionResult {
  text: string;
  /** Provider-reported total tokens, when available. */
  totalTokens?: number;
  /** The provider stopped at the output-token limit, so the JSON is probably cut off. */
  truncated?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly tokensPerMinute: number;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

const REQUEST_TIMEOUT_MS = 90_000;

async function postJson(provider: string, url: string, headers: Record<string, string>, body: unknown) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderHttpError(provider, 0, (err as Error).message);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderHttpError(provider, res.status, extractErrorMessage(text), parseRetryAfter(res.headers, text));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(provider, 502, "non-JSON response body");
  }
}

function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message?.slice(0, 300) ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** retry-after (seconds or HTTP date), Groq's x-ratelimit-reset-tokens ("7.66s", "1m2s"), or Gemini's RetryInfo. */
export function parseRetryAfter(headers: Headers, body = ""): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset-tokens");
  if (reset) {
    const ms = parseDuration(reset);
    if (ms !== undefined) return ms;
  }
  const gemini = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  if (gemini) return Math.ceil(Number(gemini[1]) * 1000);
  return undefined;
}

function parseDuration(s: string): number | undefined {
  const m = /^(?:(\d+)m)?(?:([\d.]+)s)?(?:([\d.]+)ms)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Math.ceil(Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0));
}

export class GroqProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    readonly tokensPerMinute = 7000,
  ) {
    // Groq rate limits are per model, so each model is its own provider.
    this.name = `groq:${model}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.3,
      // gpt-oss models reason before answering; keep that short so it fits the TPM budget.
      ...(this.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
    };
    const data = (await postJson("groq", "https://api.groq.com/openai/v1/chat/completions", {
      Authorization: `Bearer ${this.apiKey}`,
    }, body)) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { total_tokens?: number };
    };
    const choice = data.choices?.[0];
    return { text: choice?.message?.content ?? "", totalTokens: data.usage?.total_tokens, truncated: choice?.finish_reason === "length" };
  }
}

export class GeminiProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    readonly tokensPerMinute = 200_000,
  ) {
    this.name = `gemini:${model}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        // Gemini counts any thinking tokens against this limit, so leave headroom.
        maxOutputTokens: req.maxTokens * 2,
        temperature: req.temperature ?? 0.3,
      },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const data = (await postJson("gemini", url, { "x-goog-api-key": this.apiKey }, body)) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
      usageMetadata?: { totalTokenCount?: number };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    return { text, totalTokens: data.usageMetadata?.totalTokenCount, truncated: data.candidates?.[0]?.finishReason === "MAX_TOKENS" };
  }
}
