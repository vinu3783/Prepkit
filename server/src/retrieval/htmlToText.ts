import * as cheerio from "cheerio";

export interface PageLink {
  url: string;
  text: string;
}

export interface ParsedPage {
  url: string;
  title: string;
  description: string;
  text: string;
  links: PageLink[];
}

const MAX_TEXT_CHARS = 60_000;
const CHROME_SELECTOR = [
  "nav",
  "header",
  "footer",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[role=search]",
  "[aria-hidden=true]",
  "[hidden]",
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="navbar" i]',
  '[class*="mega-menu" i]',
  '[class*="megamenu" i]',
  '[class*="skip-link" i]',
].join(",");
const BLOCK_SELECTOR = "p,div,section,article,main,header,footer,li,ul,ol,tr,table,h1,h2,h3,h4,h5,h6,blockquote,pre,dt,dd";

/**
 * Turn an HTML page into readable text plus its outgoing links.
 * Links come from the whole document (navigation and footers are where careers
 * links live); text prefers <main>/<article> when they carry real content.
 */
export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const baseHref = $("base[href]").attr("href");
  const base = safeUrl(baseHref ?? "", pageUrl) ?? new URL(pageUrl);

  const links: PageLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")!.trim();
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith("#")) return;
    const resolved = safeUrl(href, base.href);
    if (!resolved || (resolved.protocol !== "http:" && resolved.protocol !== "https:")) return;
    resolved.hash = "";
    if (seen.has(resolved.href)) return;
    seen.add(resolved.href);
    const text = collapse($(el).text() || $(el).attr("aria-label") || $(el).attr("title") || "");
    links.push({ url: resolved.href, text: text.slice(0, 120) });
  });

  const title = collapse($("title").first().text() || $("h1").first().text());
  const description = collapse($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? "");

  $("script,style,noscript,svg,iframe,template,form,button,select,input").remove();
  // Links were collected above; for *text*, site chrome is noise that would crowd the
  // real content out of the excerpt the model sees (mega-menus run to thousands of chars).
  $(CHROME_SELECTOR).remove();
  $("br").replaceWith("\n");
  $("h1,h2,h3").each((_, el) => {
    $(el).prepend("\n## ");
  });
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).append("\n");
  });

  const main = $("main, article, [role=main]").first();
  const mainText = main.length ? toLines(main.text()) : "";
  const text = (mainText.length > 500 ? mainText : toLines($("body").text() || $.root().text())).slice(0, MAX_TEXT_CHARS);

  return { url: pageUrl, title, description, text, links };
}

/** Plain text documents (text/plain) pass straight through. */
export function parsePlainText(body: string, pageUrl: string): ParsedPage {
  return { url: pageUrl, title: "", description: "", text: toLines(body).slice(0, MAX_TEXT_CHARS), links: [] };
}

function toLines(s: string): string {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    const line = collapse(raw);
    if (!line || line === "##") continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join("\n");
}

function collapse(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim();
}

function safeUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}
