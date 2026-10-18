export type FetchErrorCode =
  | "INVALID_URL"
  | "BLOCKED_URL" // private / loopback / non-http target under a policy that forbids it
  | "ROBOTS_DISALLOWED"
  | "HTTP_ERROR"
  | "TIMEOUT"
  | "NETWORK"
  | "UNSUPPORTED_CONTENT"
  | "TOO_LARGE"
  | "TOO_MANY_REDIRECTS";

export class FetchError extends Error {
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }

  /** Worth another attempt: rate limiting, server errors and transport hiccups. */
  get retryable(): boolean {
    if (this.code === "TIMEOUT" || this.code === "NETWORK") return true;
    return this.code === "HTTP_ERROR" && (this.status === 429 || (this.status ?? 0) >= 500);
  }
}
