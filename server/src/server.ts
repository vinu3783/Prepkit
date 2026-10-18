import { createApp } from "./api/app.js";
import { AuthService } from "./auth/auth.js";
import { createLlmClient, loadEnv } from "./config.js";
import { KitRepository } from "./db/kitRepository.js";
import { connectDatabase } from "./db/mongo.js";
import { JobRunner } from "./jobs/jobRunner.js";
import { PageFetcher } from "./retrieval/fetchPage.js";
import { defaultPolicy } from "./retrieval/urlSafety.js";

async function main() {
  loadEnv();
  const database = await connectDatabase();
  const kits = new KitRepository(database.db);
  const interrupted = await kits.failInterrupted();
  if (interrupted) console.warn(`Marked ${interrupted} interrupted generation(s) as failed`);

  const llm = createLlmClient({
    log: (e) => {
      if (e.type === "retry" || e.type === "fallback" || e.type === "repair") console.log("[llm]", JSON.stringify(e).slice(0, 300));
    },
  });
  const policy = defaultPolicy();
  const fetcher = new PageFetcher({ policy });
  const jobs = new JobRunner(kits, { llm, fetcher }, Number(process.env.MAX_CONCURRENT_GENERATIONS ?? 2));
  const app = createApp({ auth: new AuthService(database.db), kits, jobs, webOrigin: process.env.WEB_ORIGIN });

  const port = Number(process.env.PORT ?? 4000);
  const server = app.listen(port, () => {
    console.log(`API listening on http://localhost:${port} (private hosts ${policy.allowPrivateHosts ? "ALLOWED" : "blocked"})`);
  });

  const shutdown = async () => {
    server.close();
    await database.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
