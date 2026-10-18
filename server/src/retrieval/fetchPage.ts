import { FetchError } from "./errors.js";
import { RobotsCache, USER_AGENT } from "./robots.js";
import { assertUrlAllowed, type UrlPolicy } from "./urlSafety.js";

export interface FetchedDocument {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface FetcherOptions {
  policy: UrlPolicy;
  timeoutMs?: number;
  maxBytes?: number;
  /** Total attempts for retryable failures (so 3 = 1 try + 2 retries). */
  attempts?: number;
  /** Minimum gap between requests to the same host. */
  perHostIntervalMs?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const HTML_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];
const XML_TYPES = ["application/xml", "text/xml"];
const MAX_REDIRECTS = 5;

/**
 * Polite, defensive HTTP GET for untrusted sites:
 *  - URL policy (no private hosts in production) checked on every redirect hop
 *  - robots.txt respected per origin
 *  - only HTML / plain text (or XML for sitemaps), capped in bytes
 *  - per-host spacing and bounded retries with exponential backoff
 */
export class PageFetcher {
  private readonly robots: RobotsCache;
  private readonly lastRequestAt = new Map<string, number>();
  /** Hosts that failed at the connection level: further URLs on them fail fast instead of re-waiting on timeouts. */
  private readonly deadHosts = new Map<string, FetchError>();
  private readonly opts: Required<FetcherOptions>;

  constructor(options: FetcherOptions) {
    this.opts = {
      timeoutMs: 10_000,
      maxBytes: 5_000_000, // marketing homepages with inlined JS can exceed 1.5 MB
      attempts: 3,
      perHostIntervalMs: 300,
      backoffMs: 500,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
    this.robots = new RobotsCache(async (url) => {
      try {
        const doc = await this.request(new URL(url), ["text/plain", "text/html"], 1);
        return doc.status === 200 ? doc.body : null;
      } catch {
        return null;
      }
    });
  }

  /** Fetch an HTML (or plain text) page. */
  fetchPage(url: URL): Promise<FetchedDocument> {
    return this.fetchWithRetries(url, HTML_TYPES);
  }

  /** Fetch an XML document such as a sitemap. */
  fetchXml(url: URL): Promise<FetchedDocument> {
    return this.fetchWithRetries(url, XML_TYPES);
  }

  private async fetchWithRetries(url: URL, accept: string[]): Promise<FetchedDocument> {
    if (!(await this.robots.isAllowed(url))) {
      throw new FetchError("ROBOTS_DISALLOWED", "Disallowed by robots.txt", url.href);
    }
    const dead = this.deadHosts.get(url.host);
    if (dead) throw new FetchError(dead.code, `${dead.message} (host already unreachable)`, url.href, dead.status);
    let lastError: FetchError | undefined;
    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      try {
        return await this.request(url, accept, MAX_REDIRECTS);
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        lastError = err;
        if (!err.retryable || attempt === this.opts.attempts) break;
        await this.opts.sleep(this.opts.backoffMs * 2 ** (attempt - 1));
      }
    }
    if (lastError!.code === "TIMEOUT" || lastError!.code === "NETWORK") this.deadHosts.set(url.host, lastError!);
    throw lastError!;
  }

  private async request(start: URL, accept: string[], redirectsLeft: number): Promise<FetchedDocument> {
    let url = start;
    for (let hop = 0; ; hop++) {
      await assertUrlAllowed(url, this.opts.policy);
      await this.throttle(url.host);

      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "manual",
          headers: { "User-Agent": USER_AGENT, Accept: `${accept.join(", ")};q=0.9, */*;q=0.1` },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
        throw new FetchError(timedOut ? "TIMEOUT" : "NETWORK", timedOut ? "Timed out" : e.message, url.href);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= redirectsLeft) throw new FetchError("TOO_MANY_REDIRECTS", "Too many redirects", start.href);
        url = new URL(res.headers.get("location")!, url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new FetchError("INVALID_URL", "Redirected to a non-http URL", url.href);
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new FetchError("HTTP_ERROR", `HTTP ${res.status}`, url.href, res.status);
      }

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (contentType && !accept.includes(contentType)) {
        await res.body?.cancel();
        throw new FetchError("UNSUPPORTED_CONTENT", `Unsupported content type ${contentType}`, url.href, res.status);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > this.opts.maxBytes) {
        await res.body?.cancel();
        throw new FetchError("TOO_LARGE", `Body is ${declared} bytes`, url.href, res.status);
      }
      const body = await readCapped(res, this.opts.maxBytes, url.href);
      return { url: url.href, status: res.status, contentType, body };
    }
  }

  private async throttle(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = last + this.opts.perHostIntervalMs - Date.now();
    this.lastRequestAt.set(host, Math.max(Date.now(), last + this.opts.perHostIntervalMs));
    if (wait > 0) await this.opts.sleep(wait);
  }
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError("TOO_LARGE", `Body exceeded ${maxBytes} bytes`, url);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}
