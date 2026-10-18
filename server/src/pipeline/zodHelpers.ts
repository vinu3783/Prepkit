import { z } from "zod";

/**
 * Lenient parsers for model output. Each fixes a known harmless deviation
 * (null for "", a single string where a list was asked for, "2" for 2) so a
 * cosmetic slip does not cost a repair round-trip. Anything else still fails
 * validation and triggers the repair path in LlmClient.
 */

export const lenientString = z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string());

/** Accept a string or an array of strings, returned as a single string (bulleted when a list). */
export const textOrList = z.preprocess(
  (v) => (Array.isArray(v) ? v.map((x) => `- ${String(x).replace(/^[-*•]\s*/, "")}`).join("\n") : v === null || v === undefined ? "" : v),
  z.string(),
);

export const lenientArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(item));

export const difficulty = z.preprocess((v) => {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? Math.round(v) : 2;
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 2;
}, z.number().int().min(1).max(3));

/** A list of short strings; objects like {"fact": "...", "source": "..."} are flattened to their first string value. */
export const stringList = z.preprocess(
  (v) =>
    (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]).map((x) =>
      typeof x === "string" ? x : x && typeof x === "object" ? (Object.values(x).find((y) => typeof y === "string") ?? "") : String(x),
    ),
  z.array(z.string()),
);
