import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static server for the fixture company sites in server/fixtures/sites, mirroring
 * how the graders serve sites (http://localhost:8099/<company>/).
 * Usage: npm run mock-sites   (port from PORT, default 8099)
 */

const ROOT = resolve(fileURLToPath(new URL("../../fixtures/sites", import.meta.url)));
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".txt": "text/plain", ".xml": "application/xml" };

export function startMockSites(port = 0): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path.startsWith("/slow/")) return; // never responds: exercises timeouts
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) {
        if (!path.endsWith("/")) {
          res.writeHead(301, { Location: `${path}/` }).end();
          return;
        }
        file = join(file, "index.html");
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/html" }).end("<h1>Not found</h1>");
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, baseUrl: `http://localhost:${actualPort}` });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8099);
  startMockSites(port).then(({ baseUrl }) => console.log(`Mock company sites at ${baseUrl}/acme/, /quietco/, /tiny/`));
}
