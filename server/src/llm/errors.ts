/** Failure categories the rest of the pipeline can act on without knowing which provider was used. */
export type LlmErrorCode =
  | "RATE_LIMITED" // retries and fallbacks exhausted on 429s
  | "PROVIDER_UNAVAILABLE" // 5xx / network / timeout after retries
  | "PROVIDER_CONFIG" // bad key, unknown model, malformed request: retrying will not help
  | "INVALID_OUTPUT"; // model kept returning JSON that fails the schema

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Raised by a provider adapter for a non-2xx response or a transport failure. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    /** HTTP status, or 0 for network errors and timeouts. */
    public readonly status: number,
    message: string,
    /** Server-suggested wait before retrying, if it sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(`${provider} ${status || "network"}: ${message}`);
    this.name = "ProviderHttpError";
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}
