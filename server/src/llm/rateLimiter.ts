export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Rough token estimate (~4 chars per token for English). Deliberately conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

interface Reservation {
  at: number;
  tokens: number;
}

/**
 * Sliding-window tokens-per-minute limiter. Free tiers cap tokens per minute,
 * so we wait *before* sending a request that would overflow the window instead
 * of discovering it from a 429. Acquisitions are serialised so concurrent callers
 * cannot both see the same free capacity.
 */
export class TokenRateLimiter {
  private reservations: Reservation[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly tokensPerMinute: number,
    private readonly clock: Clock = realClock,
    private readonly windowMs = 60_000,
  ) {}

  /** Wait until `tokens` fit in the window, then reserve them. Returns a handle to settle actual usage. */
  acquire(tokens: number): Promise<Reservation> {
    const request = Math.min(tokens, this.tokensPerMinute); // an oversize request still gets to run alone
    const run = async () => {
      for (;;) {
        this.evictExpired();
        const used = this.reservations.reduce((a, r) => a + r.tokens, 0);
        if (used + request <= this.tokensPerMinute) {
          const reservation = { at: this.clock.now(), tokens: request };
          this.reservations.push(reservation);
          return reservation;
        }
        const oldest = this.reservations[0]!;
        await this.clock.sleep(Math.max(1, oldest.at + this.windowMs - this.clock.now()));
      }
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** How long acquire(tokens) would wait right now, ignoring callers already queued. */
  estimateWaitMs(tokens: number): number {
    this.evictExpired();
    const request = Math.min(tokens, this.tokensPerMinute);
    let used = this.reservations.reduce((a, r) => a + r.tokens, 0);
    if (used + request <= this.tokensPerMinute) return 0;
    for (const r of this.reservations) {
      used -= r.tokens;
      if (used + request <= this.tokensPerMinute) return Math.max(0, r.at + this.windowMs - this.clock.now());
    }
    return this.windowMs;
  }

  /** Replace an estimate with the provider-reported usage once the call finishes. */
  settle(reservation: Reservation, actualTokens: number): void {
    reservation.tokens = Math.max(0, actualTokens);
  }

  /** Back off the whole window after a 429: the provider's view of usage is the truth. */
  block(ms: number): void {
    this.reservations.push({ at: this.clock.now() - this.windowMs + ms, tokens: this.tokensPerMinute });
  }

  private evictExpired(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.reservations = this.reservations.filter((r) => r.at > cutoff);
  }
}
