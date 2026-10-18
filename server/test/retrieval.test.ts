import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlCompanySite } from "../src/retrieval/crawler.js";
import { FetchError } from "../src/retrieval/errors.js";
import { PageFetcher } from "../src/retrieval/fetchPage.js";
import { parseHtml } from "../src/retrieval/htmlToText.js";
import { hiringProcessSignal, scoreLink } from "../src/retrieval/linkScoring.js";
import { isPathAllowed, parseRobots } from "../src/retrieval/robots.js";
import { assertUrlAllowed, parseHttpUrl } from "../src/retrieval/urlSafety.js";
import { startMockSites } from "../src/scripts/mockSites.js";

let server: Server;
let base: string;
const fetcher = () => new PageFetcher({ policy: { allowPrivateHosts: true }, perHostIntervalMs: 0, backoffMs: 1, timeoutMs: 1500 });

beforeAll(async () => {
  ({ server, baseUrl: base } = await startMockSites());
});
afterAll(() => {
  server.close();
});

describe("url safety", () => {
  it("rejects non-http schemes and credentials", () => {
    expect(() => parseHttpUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => parseHttpUrl("ftp://acme.com")).toThrow(/http/);
    expect(() => parseHttpUrl("https://user:pw@acme.com")).toThrow(/credentials/);
    expect(() => parseHttpUrl("not a url at all")).toThrow();
  });

  it("adds https:// to a bare domain", () => {
    expect(parseHttpUrl("acme.com").href).toBe("https://acme.com/");
  });

  it.each(["http://127.0.0.1/", "http://localhost:8099/acme/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://192.168.1.1/"])(
    "blocks %s under the production policy",
    async (url) => {
      await expect(assertUrlAllowed(new URL(url), { allowPrivateHosts: false })).rejects.toMatchObject({ code: "BLOCKED_URL" });
    },
  );

  it("allows private hosts when the policy permits (local dev, batch)", async () => {
    await expect(assertUrlAllowed(new URL("http://localhost:8099/"), { allowPrivateHosts: true })).resolves.toBeUndefined();
  });
});

describe("robots.txt", () => {
  const rules = parseRobots(
    ["User-agent: *", "Disallow: /private/", "Allow: /private/ok", "", "User-agent: PrepKitBot", "Disallow: /no-bots/", "Disallow: /*.pdf$"].join("\n"),
  );

  it("uses the group addressed to our agent over the wildcard group", () => {
    expect(isPathAllowed(rules, "/no-bots/page")).toBe(false);
    expect(isPathAllowed(rules, "/private/x")).toBe(true);
  });

  it("supports * and $ patterns", () => {
    expect(isPathAllowed(rules, "/files/a.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/files/a.pdf?x=1")).toBe(true);
  });

  it("lets the longest match win, with Allow winning ties", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a/\nAllow: /a/b/");
    expect(isPathAllowed(r, "/a/x")).toBe(false);
    expect(isPathAllowed(r, "/a/b/c")).toBe(true);
  });

  it("is enforced by the fetcher", async () => {
    await expect(fetcher().fetchPage(new URL(`${base}/acme/internal/admin.html`))).rejects.toMatchObject({ code: "ROBOTS_DISALLOWED" });
  });
});

describe("html to text", () => {
  it("extracts text without scripts and resolves relative links", () => {
    const page = parseHtml(
      `<html><head><title> T </title><script>evil()</script></head><body><nav><a href="../careers/">Careers</a><a href="mailto:x@y">mail</a></nav><p>Hello <b>world</b></p></body></html>`,
      "https://acme.test/en/home/",
    );
    expect(page.title).toBe("T");
    expect(page.text).toContain("Hello world");
    expect(page.text).not.toContain("evil");
    expect(page.links).toEqual([{ url: "https://acme.test/en/careers/", text: "Careers" }]);
  });
});

describe("link scoring", () => {
  it("ranks hiring and about links above noise without fixed paths", () => {
    const hiring = scoreLink("https://x.com/handbook/people/how-we-hire", "");
    const about = scoreLink("https://x.com/company/", "Who we are");
    const legal = scoreLink("https://x.com/legal/privacy", "Privacy policy");
    const pdf = scoreLink("https://x.com/careers/brochure.pdf", "Careers brochure");
    expect(hiring.intent).toBe("hiring");
    expect(about.intent).toBe("about");
    expect(hiring.score).toBeGreaterThan(about.score);
    expect(legal.score).toBeLessThan(0);
    expect(pdf.score).toBeLessThan(0);
  });

  it("uses anchor text when the path says nothing", () => {
    expect(scoreLink("https://x.com/p/7731", "Join the team").intent).toBe("hiring");
  });

  it("detects interview-process language in page text", () => {
    expect(hiringProcessSignal("Our interview process: recruiter screen, take-home, system design, offer")).toBeGreaterThanOrEqual(5);
    expect(hiringProcessSignal("We sell books to shops.")).toBe(0);
  });
});

describe("fetcher", () => {
  it("records a 404 as an HTTP error", async () => {
    await expect(fetcher().fetchPage(new URL(`${base}/nope/`))).rejects.toMatchObject({ code: "HTTP_ERROR", status: 404 });
  });

  it("times out on a site that never responds, after its retries", async () => {
    const err = await fetcher()
      .fetchPage(new URL(`${base}/slow/`))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe("TIMEOUT");
  }, 10_000);

  it("follows redirects (directory without trailing slash)", async () => {
    const doc = await fetcher().fetchPage(new URL(`${base}/acme`));
    expect(doc.url).toBe(`${base}/acme/`);
  });
});

describe("crawlCompanySite", () => {
  it("finds a hiring process buried in a handbook, two links away", async () => {
    const result = await crawlCompanySite(`${base}/acme/`, fetcher());
    expect(result.reachable).toBe(true);
    expect(result.hiringPageUrl).toBe(`${base}/acme/handbook/people/hiring-process.html`);
    expect(result.hiringProcessDescribed).toBe(true);
    expect(result.aboutPageUrl).toBe(`${base}/acme/company/`);
    // stays inside /acme/ and records the broken privacy link instead of failing
    expect(result.pages.every((p) => p.url.startsWith(`${base}/acme/`))).toBe(true);
  });

  it("reports honestly when a site has no hiring page anywhere", async () => {
    const result = await crawlCompanySite(`${base}/quietco/`, fetcher());
    expect(result.reachable).toBe(true);
    expect(result.hiringPageUrl).toBeNull();
    expect(result.hiringProcessDescribed).toBe(false);
    expect(result.pages[0]!.text).toContain("independent bookshops");
  });

  it("does not wander into sibling companies on the same host", async () => {
    const result = await crawlCompanySite(`${base}/tiny/`, fetcher());
    expect(result.pages.map((p) => p.url)).toEqual([`${base}/tiny/`]);
  });

  it("reports an unreachable site as data, not an exception", async () => {
    const result = await crawlCompanySite(`${base}/does-not-exist/`, fetcher());
    expect(result.reachable).toBe(false);
    expect(result.error?.code).toBe("COMPANY_UNREACHABLE");
    expect(result.skipped[0]!.reason).toBe("HTTP 404");
  });

  it("reports an invalid URL", async () => {
    const result = await crawlCompanySite("javascript:alert(1)", fetcher());
    expect(result.error?.code).toBe("INVALID_URL");
  });
});

describe("registrableDomain", () => {
  it("scopes a crawl to the company's domain, not just the start host", async () => {
    const { registrableDomain } = await import("../src/retrieval/crawler.js");
    expect(registrableDomain("about.gitlab.com")).toBe("gitlab.com");
    expect(registrableDomain("www.stripe.com")).toBe("stripe.com");
    expect(registrableDomain("jobs.acme.co.uk")).toBe("acme.co.uk");
  });
});

describe("html to text: site chrome", () => {
  it("drops navigation, header, footer and cookie banners from text but keeps their links", () => {
    const page = parseHtml(
      `<html><body><header><nav><a href="/careers">Careers</a> Products Solutions Pricing</nav></header>
       <div class="cookie-banner">We use cookies</div>
       <div><h1>How we interview</h1><p>Stage 1: recruiter screen.</p></div>
       <footer><a href="/handbook">Handbook</a> © 2026</footer></body></html>`,
      "https://x.test/",
    );
    expect(page.text).toContain("How we interview");
    expect(page.text).not.toMatch(/Products Solutions|cookies|©/);
    expect(page.links.map((l) => l.text)).toEqual(["Careers", "Handbook"]);
  });
});

describe("dead host circuit breaker", () => {
  it("fails fast on further URLs of a host that already timed out", async () => {
    const f = fetcher();
    await expect(f.fetchPage(new URL(`${base}/slow/a`))).rejects.toMatchObject({ code: "TIMEOUT" });
    const t = Date.now();
    await expect(f.fetchPage(new URL(`${base}/slow/b`))).rejects.toThrow(/already unreachable/);
    expect(Date.now() - t).toBeLessThan(200);
  }, 15_000);
});
