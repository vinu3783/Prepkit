import { FetchError } from "./errors.js";
import type { PageFetcher } from "./fetchPage.js";
import { parseHtml, parsePlainText, type ParsedPage } from "./htmlToText.js";
import { hiringProcessSignal, scoreLink, type LinkIntent } from "./linkScoring.js";
import { parseHttpUrl } from "./urlSafety.js";

export type PageKind = "home" | "about" | "hiring" | "other";

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  text: string;
  kind: PageKind;
  /** How much the page text talks about an interview / hiring process. */
  processSignal: number;
}

export interface SkippedSource {
  url: string;
  reason: string;
}

export interface CrawlResult {
  startUrl: string;
  reachable: boolean;
  pages: CrawledPage[];
  skipped: SkippedSource[];
  /** Best page describing how they hire, if any was found. */
  hiringPageUrl: string | null;
  /** Whether that page actually describes a process (vs. a bare jobs list). */
  hiringProcessDescribed: boolean;
  aboutPageUrl: string | null;
  error: { code: string; message: string } | null;
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  log?: (message: string) => void;
}

interface Candidate {
  url: string;
  score: number;
  intent: LinkIntent;
  depth: number;
}

/**
 * Best-first crawl of a company site:
 *  1. fetch the start URL (failure here = site unreachable, reported, not thrown)
 *  2. seed candidates from its links and from sitemap.xml
 *  3. repeatedly fetch the highest-scoring unvisited candidate within budget
 *  4. classify each page (home / about / hiring / other) from URL + text evidence
 * Scope: same host, under the start URL's path (several companies may share one
 * host in the test harness, e.g. http://localhost:8099/acme/), plus subdomains of
 * the company's domain (careers.acme.com) when the start URL is a site root.
 */
export async function crawlCompanySite(rawUrl: string, fetcher: PageFetcher, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 8;
  const maxDepth = options.maxDepth ?? 2;
  const log = options.log ?? (() => {});
  const result: CrawlResult = {
    startUrl: rawUrl,
    reachable: false,
    pages: [],
    skipped: [],
    hiringPageUrl: null,
    hiringProcessDescribed: false,
    aboutPageUrl: null,
    error: null,
  };

  let start: URL;
  try {
    start = parseHttpUrl(rawUrl);
  } catch (err) {
    result.error = { code: "INVALID_URL", message: (err as Error).message };
    return result;
  }
  result.startUrl = start.href;
  const inScope = scopeFor(start);

  let home: ParsedPage;
  try {
    home = await fetchParsed(fetcher, start);
  } catch (err) {
    const fe = err instanceof FetchError ? err : new FetchError("NETWORK", String(err), start.href);
    result.error = { code: "COMPANY_UNREACHABLE", message: describeFetchError(fe) };
    result.skipped.push({ url: start.href, reason: describeFetchError(fe) });
    return result;
  }
  result.reachable = true;
  const visited = new Set<string>([normalize(start.href), normalize(home.url)]);
  result.pages.push(toCrawledPage(home, "home"));
  log(`fetched home ${home.url}`);

  const frontier = new Map<string, Candidate>();
  const enqueue = (url: string, text: string, depth: number, fromHiring: boolean) => {
    const key = normalize(url);
    if (visited.has(key) || depth > maxDepth) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!inScope(parsed)) return;
    const scored = scoreLink(url, text, fromHiring);
    if (scored.score <= 0) return;
    const existing = frontier.get(key);
    if (!existing || existing.score < scored.score) frontier.set(key, { url, score: scored.score, intent: scored.intent, depth });
  };

  for (const link of home.links) enqueue(link.url, link.text, 1, false);
  for (const url of await sitemapUrls(fetcher, start, inScope, result.skipped)) enqueue(url, "", 1, false);

  while (result.pages.length < maxPages && frontier.size > 0) {
    const next = [...frontier.values()].sort((a, b) => b.score - a.score)[0]!;
    frontier.delete(normalize(next.url));
    visited.add(normalize(next.url));
    let page: ParsedPage;
    try {
      page = await fetchParsed(fetcher, new URL(next.url));
    } catch (err) {
      const reason = err instanceof FetchError ? describeFetchError(err) : String(err);
      result.skipped.push({ url: next.url, reason });
      log(`skipped ${next.url}: ${reason}`);
      continue;
    }
    if (visited.has(normalize(page.url)) && normalize(page.url) !== normalize(next.url)) continue; // redirected to a page we have
    visited.add(normalize(page.url));
    const crawled = toCrawledPage(page, classify(next.intent, page));
    result.pages.push(crawled);
    log(`fetched ${crawled.kind} ${page.url} (link score ${next.score}, process signal ${crawled.processSignal})`);
    for (const link of page.links) enqueue(link.url, link.text, next.depth + 1, crawled.kind === "hiring");
  }

  const hiring = result.pages
    .filter((p) => p.kind === "hiring")
    .sort((a, b) => b.processSignal - a.processSignal)[0];
  // The home page itself can describe the process on a tiny one-page site.
  const homeAsHiring = !hiring && result.pages[0]!.processSignal >= 6 ? result.pages[0] : undefined;
  const best = hiring ?? homeAsHiring;
  result.hiringPageUrl = best?.url ?? null;
  result.hiringProcessDescribed = (best?.processSignal ?? 0) >= 4;
  result.aboutPageUrl = result.pages.find((p) => p.kind === "about")?.url ?? null;
  return result;
}

function classify(intent: LinkIntent, page: ParsedPage): PageKind {
  const signal = hiringProcessSignal(page.text);
  const titleIntent = scoreLink(page.url, page.title).intent;
  if ((intent === "hiring" || titleIntent === "hiring") && signal >= 1) return "hiring";
  if (signal >= 8) return "hiring";
  if (intent === "about" || titleIntent === "about") return "about";
  if (intent === "hiring" || titleIntent === "hiring") return "hiring";
  return "other";
}

function toCrawledPage(page: ParsedPage, kind: PageKind): CrawledPage {
  return {
    url: page.url,
    title: page.title,
    description: page.description,
    text: page.text,
    kind,
    processSignal: hiringProcessSignal(page.text),
  };
}

async function fetchParsed(fetcher: PageFetcher, url: URL): Promise<ParsedPage> {
  const doc = await fetcher.fetchPage(url);
  return doc.contentType === "text/plain" ? parsePlainText(doc.body, doc.url) : parseHtml(doc.body, doc.url);
}

async function sitemapUrls(fetcher: PageFetcher, start: URL, inScope: (u: URL) => boolean, skipped: SkippedSource[]): Promise<string[]> {
  const candidates = new Set([new URL("sitemap.xml", start).href, `${start.origin}/sitemap.xml`]);
  for (const url of candidates) {
    try {
      const doc = await fetcher.fetchXml(new URL(url));
      const locs = [...doc.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);
      return locs
        .filter((loc) => {
          try {
            return inScope(new URL(loc));
          } catch {
            return false;
          }
        })
        .slice(0, 500);
    } catch (err) {
      // A missing sitemap is normal; only record unusual failures.
      if (err instanceof FetchError && err.code !== "HTTP_ERROR" && err.code !== "UNSUPPORTED_CONTENT") {
        skipped.push({ url, reason: describeFetchError(err) });
      }
    }
  }
  return [];
}

function scopeFor(start: URL): (u: URL) => boolean {
  const basePath = start.pathname.endsWith("/") ? start.pathname : start.pathname.replace(/[^/]*$/, "");
  const companyDomain = registrableDomain(start.hostname);
  return (u) => {
    if (u.protocol !== start.protocol && !(u.protocol === "https:" && start.protocol === "http:")) return false;
    if (u.host === start.host) return u.pathname.startsWith(basePath);
    // Other hosts of the same company (handbook.gitlab.com from about.gitlab.com,
    // careers.acme.com from acme.com), only when crawling a site root.
    if (basePath !== "/" || isIpOrLocal(start.hostname)) return false;
    return u.hostname === companyDomain || u.hostname.endsWith(`.${companyDomain}`);
  };
}

/** Second-level public suffixes common enough to matter (acme.co.uk, acme.com.au). */
const TWO_LEVEL_SUFFIXES = /\.(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

/** "about.gitlab.com" -> "gitlab.com", "jobs.acme.co.uk" -> "acme.co.uk". */
export function registrableDomain(hostname: string): string {
  const labels = hostname.replace(/^www\./, "").split(".");
  const keep = TWO_LEVEL_SUFFIXES.test(hostname) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function isIpOrLocal(host: string): boolean {
  return host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":");
}

export function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (key.startsWith("utm_")) u.searchParams.delete(key);
    let s = u.href;
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s.replace(/\/index\.html?$/i, "");
  } catch {
    return url;
  }
}

export function describeFetchError(err: FetchError): string {
  switch (err.code) {
    case "HTTP_ERROR":
      return `HTTP ${err.status}`;
    case "TIMEOUT":
      return "timed out";
    case "ROBOTS_DISALLOWED":
      return "disallowed by robots.txt";
    case "BLOCKED_URL":
      return `blocked: ${err.message}`;
    default:
      return err.message;
  }
}
