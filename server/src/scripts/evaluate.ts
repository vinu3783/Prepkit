/**
 * Batch entry point (Section 9):
 *   npm run evaluate -- --input <cases.json> --output <kits.json> [--concurrency 2]
 *
 * Runs the same pipeline as the web app (generateKit) on every case, records
 * per-case failures instead of aborting, and rewrites the output file after each
 * case so a crash never loses finished work.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createLlmClient, loadEnv } from "../config.js";
import type { Kit } from "../domain/schema.js";
import { LlmError } from "../llm/errors.js";
import { generateKit, PipelineError } from "../pipeline/generateKit.js";
import { PageFetcher } from "../retrieval/fetchPage.js";

const CaseSchema = z.object({
  id: z.string().min(1),
  jd: z.string(),
  company_url: z.string(),
  days: z.number(),
});

type CaseOutcome =
  | { id: string; status: "ok"; kit: Kit; error: null }
  | { id: string; status: "failed"; kit: null; error: { code: string; message: string } };

const CASE_TIMEOUT_MS = 8 * 60_000;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2);
      args.set(key!, inline ?? argv[++i] ?? "");
    }
  }
  const input = args.get("input");
  const output = args.get("output");
  if (!input || !output) {
    console.error("Usage: npm run evaluate -- --input <cases.json> --output <kits.json> [--concurrency 2]");
    process.exit(2);
  }
  const concurrency = Math.max(1, Math.min(5, Number(args.get("concurrency") ?? 2) || 2));
  return { input: resolve(input), output: resolve(output), concurrency };
}

function log(message: string) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

function toFailure(id: string, err: unknown): CaseOutcome {
  const code = err instanceof PipelineError ? err.code : err instanceof LlmError ? `LLM_${err.code}` : "INTERNAL_ERROR";
  return { id, status: "failed", kit: null, error: { code, message: (err as Error)?.message ?? String(err) } };
}

async function main() {
  const { input, output, concurrency } = parseArgs(process.argv.slice(2));
  loadEnv();

  let rawCases: unknown;
  try {
    rawCases = JSON.parse(await readFile(input, "utf8"));
  } catch (err) {
    console.error(`Cannot read input ${input}: ${(err as Error).message}`);
    process.exit(2);
  }
  if (!Array.isArray(rawCases)) {
    console.error("Input must be a JSON array of cases");
    process.exit(2);
  }

  const llm = createLlmClient({
    log: (e) => {
      if (e.type === "retry") log(`  llm retry ${e.provider} #${e.attempt} in ${e.waitMs}ms: ${e.reason}`);
      if (e.type === "fallback") log(`  llm fallback ${e.from} -> ${e.to}`);
      if (e.type === "repair") log(`  llm repair (${e.provider}): ${e.issues.slice(0, 2).join("; ")}`);
    },
  });
  // Graders serve company sites from localhost, so the batch allows private hosts
  // unless explicitly told not to. The web app blocks them in production.
  const fetcher = new PageFetcher({ policy: { allowPrivateHosts: process.env.ALLOW_PRIVATE_HOSTS !== "false" } });

  const results: CaseOutcome[] = [];
  const write = () =>
    writeFile(output, JSON.stringify({ version: "1.0", generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), kits: results }, null, 2));

  // Identical submissions share one run.
  const inFlight = new Map<string, Promise<Kit>>();
  const started = Date.now();

  async function runCase(raw: unknown, index: number): Promise<CaseOutcome> {
    const parsed = CaseSchema.safeParse(raw);
    const id = parsed.success ? parsed.data.id : String((raw as { id?: unknown })?.id ?? `case-${index + 1}`);
    if (!parsed.success) {
      return { id, status: "failed", kit: null, error: { code: "INVALID_CASE", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } };
    }
    const c = parsed.data;
    const key = JSON.stringify([c.jd.trim(), c.company_url.trim(), c.days]);
    const t0 = Date.now();
    log(`${id}: start (${c.company_url}, ${c.days} day(s), ${c.jd.length} chars)`);
    try {
      let job = inFlight.get(key);
      if (job) log(`${id}: identical to an earlier case, reusing its run`);
      else {
        job = withTimeout(
          generateKit({ jd: c.jd, companyUrl: c.company_url, days: c.days }, { llm, fetcher }, (e) => {
            if (e.status !== "running" || e.step === "coverage") log(`${id}: ${e.step} ${e.status} — ${e.message}`);
          }).then((r) => r.kit),
          CASE_TIMEOUT_MS,
        );
        inFlight.set(key, job);
      }
      const kit = await job;
      log(`${id}: ok in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${kit.role.requirements.length} reqs, ${kit.questions.length} questions, ${kit.coverage.passes} coverage pass(es)`);
      return { id, status: "ok", kit, error: null };
    } catch (err) {
      const failure = toFailure(id, err);
      log(`${id}: FAILED ${failure.error?.code}: ${failure.error?.message}`);
      return failure;
    }
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, rawCases.length) }, async () => {
    while (next < rawCases.length) {
      const index = next++;
      results.push(await runCase(rawCases[index], index));
      await write();
    }
  });
  await Promise.all(workers);
  await write();

  const ok = results.filter((r) => r.status === "ok").length;
  log(`done: ${ok}/${results.length} ok in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${output}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new PipelineError("CASE_TIMEOUT", `Case exceeded ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
