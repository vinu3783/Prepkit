// Debug helper: show what the crawler reads for a site. Usage: npx tsx src/scripts/crawl.ts <url>
import { crawlCompanySite } from "../retrieval/crawler.js";
import { PageFetcher } from "../retrieval/fetchPage.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npx tsx src/scripts/crawl.ts <url>");
  process.exit(2);
}
const result = await crawlCompanySite(url, new PageFetcher({ policy: { allowPrivateHosts: true } }), { log: (m) => console.log(" ", m) });
console.log({ hiringPageUrl: result.hiringPageUrl, described: result.hiringProcessDescribed, aboutPageUrl: result.aboutPageUrl, skipped: result.skipped });
