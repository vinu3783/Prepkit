import type { z } from "zod";
import { LlmError, ProviderHttpError } from "./errors.js";
import type { LlmProvider } from "./providers.js";
import { estimateTokens, realClock, TokenRateLimiter, type Clock } from "./rateLimiter.js";

const OVERFLOW_WAIT_MS = 5_000;

export interface LlmClientOptions {
  /** Attempts per provider for retryable HTTP failures (429, 5xx, network). */
  maxAttemptsPerProvider?: number;
  /** Upper bound on total time one call may spend waiting on backoff, across providers. */
  maxWaitMsPerCall?: number;
  baseBackoffMs?: number;
  clock?: Clock;
  random?: () => number;
  log?: (event: LlmEvent) => void;
}

export type LlmEvent =
  | { type: "retry"; provider: string; attempt: number; waitMs: number; reason: string }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "repair"; provider: string; issues: string[] }
  | { type: "success"; provider: string; tokens?: number };

export interface JsonRequest<S extends z.ZodTypeAny> {
  /** Short label for logs, e.g. "extract-requirements". */
  task: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Every model call in the app goes through here. Responsibilities:
 *  - pre-emptive tokens-per-minute throttling per provider
 *  - retry with exponential backoff + jitter, honouring retry-after
 *  - fall back to the next provider when one is exhausted or unavailable
 *  - parse + schema-validate JSON, with one repair round-trip on failure
 * Non-retryable errors (bad key, unknown model) fail fast with PROVIDER_CONFIG.
 */
export class LlmClient {
  private readonly limiters = new Map<string, TokenRateLimiter>();
  private readonly opts: Required<Omit<LlmClientOptions, "log">> & Pick<LlmClientOptions, "log">;

  constructor(
    private readonly providers: LlmProvider[],
    options: LlmClientOptions = {},
  ) {
    if (providers.length === 0) throw new LlmError("PROVIDER_CONFIG", "No LLM provider configured");
    this.opts = {
      maxAttemptsPerProvider: 4,
      maxWaitMsPerCall: 120_000,
      baseBackoffMs: 2_000,
      clock: realClock,
      random: Math.random,
      ...options,
    };
    for (const p of providers) this.limiters.set(p.name, new TokenRateLimiter(p.tokensPerMinute, this.opts.clock));
  }

  async generateJson<S extends z.ZodTypeAny>(req: JsonRequest<S>): Promise<z.output<S>> {
    let maxTokens = req.maxTokens ?? 2048;
    let user = req.user;
    let lastIssues: string[] = [];

    // Attempt 0 is the normal call; attempt 1 is a repair re-ask with the validation errors.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, provider, truncated } = await this.complete({ system: req.system, user, maxTokens, temperature: req.temperature });
      const parsed = parseJsonLoose(text);
      if (parsed.ok) {
        const result = req.schema.safeParse(parsed.value);
        if (result.success) return result.data as z.output<S>;
        lastIssues = result.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      } else {
        lastIssues = [truncated ? "response was cut off at the token limit" : parsed.error];
      }
      this.opts.log?.({ type: "repair", provider, issues: lastIssues });
      // A cut-off answer needs room, not a scolding: double the budget for the retry.
      if (truncated) maxTokens = Math.min(maxTokens * 2, 8000);
      user =
        `${req.user}\n\n---\nYour previous reply was rejected by the validator:\n` +
        lastIssues.map((i) => `- ${i}`).join("\n") +
        `\nReturn the complete JSON object again, fixing these problems${truncated ? " and keeping every field concise" : ""}. JSON only.`;
    }
    throw new LlmError("INVALID_OUTPUT", `${req.task}: model output failed validation (${lastIssues.join("; ")})`);
  }

  /**
   * Provider order for one call: configured order, except that a provider whose
   * token window is full (would wait > OVERFLOW_WAIT_MS) yields to one that can
   * serve now. Keeps the batch inside its time budget on free tiers.
   */
  private orderProviders(estimate: number): LlmProvider[] {
    const waits = new Map(this.providers.map((p) => [p.name, this.limiters.get(p.name)!.estimateWaitMs(estimate)]));
    const ready = this.providers.filter((p) => waits.get(p.name)! <= OVERFLOW_WAIT_MS);
    const waiting = this.providers.filter((p) => waits.get(p.name)! > OVERFLOW_WAIT_MS).sort((a, b) => waits.get(a.name)! - waits.get(b.name)!);
    return [...ready, ...waiting];
  }

  private async complete(req: { system: string; user: string; maxTokens: number; temperature?: number }) {
    const deadline = this.opts.clock.now() + this.opts.maxWaitMsPerCall;
    let lastError: ProviderHttpError | undefined;
    // Providers count max_tokens against the budget up front, but reasoning models rarely use it all.
    const estimate = estimateTokens(req.system + req.user) + Math.ceil(req.maxTokens * 0.6);
    const ordered = this.orderProviders(estimate);

    for (const [index, provider] of ordered.entries()) {
      if (index > 0 && lastError) {
        this.opts.log?.({ type: "fallback", from: ordered[index - 1]!.name, to: provider.name, reason: lastError.message });
      }
      const limiter = this.limiters.get(provider.name)!;

      for (let attempt = 1; attempt <= this.opts.maxAttemptsPerProvider; attempt++) {
        const reservation = await limiter.acquire(estimate);
        try {
          const result = await provider.complete(req);
          limiter.settle(reservation, result.totalTokens ?? estimate);
          this.opts.log?.({ type: "success", provider: provider.name, tokens: result.totalTokens });
          return { text: result.text, provider: provider.name, truncated: result.truncated ?? false };
        } catch (err) {
          limiter.settle(reservation, 0); // a rejected request consumed nothing
          if (!(err instanceof ProviderHttpError)) throw err;
          lastError = err;
          if (!err.retryable) {
            // A misconfigured provider should not hide behind a fallback silently, but the
            // fallback may still be fine (e.g. Groq model retired), so try the next one.
            if (index < ordered.length - 1) break;
            throw new LlmError("PROVIDER_CONFIG", err.message, err);
          }
          const backoff = this.opts.baseBackoffMs * 2 ** (attempt - 1);
          const jitter = backoff * 0.25 * this.opts.random();
          const waitMs = Math.max(err.retryAfterMs ?? 0, backoff + jitter);
          const remaining = deadline - this.opts.clock.now();
          const othersLeft = index < ordered.length - 1;
          if (err.status === 429 && waitMs > OVERFLOW_WAIT_MS && othersLeft) {
            // A long "slow down" (or a daily quota) on this provider: park it and move on now.
            limiter.block(waitMs);
            break;
          }
          if (attempt === this.opts.maxAttemptsPerProvider || waitMs > remaining) break;
          this.opts.log?.({ type: "retry", provider: provider.name, attempt, waitMs: Math.round(waitMs), reason: err.message });
          // On 429 the limiter holds every caller of this provider back; the next acquire() waits.
          if (err.status === 429) limiter.block(waitMs);
          else await this.opts.clock.sleep(waitMs);
        }
      }
    }

    if (lastError?.status === 429) throw new LlmError("RATE_LIMITED", lastError.message, lastError);
    if (lastError && !lastError.retryable) throw new LlmError("PROVIDER_CONFIG", lastError.message, lastError);
    throw new LlmError("PROVIDER_UNAVAILABLE", lastError?.message ?? "all providers failed", lastError);
  }
}

/** Accepts bare JSON, JSON in a ```fence```, or JSON with stray prose around a single top-level object. */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty response" };
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      /* try next candidate */
    }
  }
  return { ok: false, error: `response was not valid JSON (starts: ${JSON.stringify(trimmed.slice(0, 60))})` };
}
