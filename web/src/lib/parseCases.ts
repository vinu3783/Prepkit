export interface CaseInput {
  jd: string;
  company_url: string;
  days: number;
}

export interface ParsedCases {
  items: CaseInput[];
  errors: string[];
}

/**
 * Accepts the batch file format (JSON array of { jd, company_url, days }, extra
 * fields such as id ignored) or a CSV with columns jd, company_url, days.
 */
export function parseCasesFile(name: string, text: string, defaultDays: number): ParsedCases {
  const errors: string[] = [];
  let rows: Record<string, unknown>[];
  try {
    if (name.toLowerCase().endsWith(".json") || text.trim().startsWith("[")) {
      const data = JSON.parse(text) as unknown;
      if (!Array.isArray(data)) return { items: [], errors: ["The JSON file must contain an array."] };
      rows = data as Record<string, unknown>[];
    } else {
      rows = parseCsv(text);
    }
  } catch (err) {
    return { items: [], errors: [`Could not read the file: ${(err as Error).message}`] };
  }

  const items: CaseInput[] = [];
  rows.forEach((row, i) => {
    const jd = String(row.jd ?? row.job_description ?? "").trim();
    const company_url = String(row.company_url ?? row.url ?? row.company ?? "").trim();
    const days = row.days === undefined || row.days === "" ? defaultDays : Number(row.days);
    if (!jd || !company_url) errors.push(`Row ${i + 1}: needs both a job description and a company URL.`);
    else if (!Number.isInteger(days) || days < 1 || days > 365) errors.push(`Row ${i + 1}: days must be a whole number from 1 to 365.`);
    else items.push({ jd, company_url, days });
  });
  if (items.length > 10) {
    errors.push(`Only the first 10 of ${items.length} roles will be created.`);
    items.length = 10;
  }
  return { items, errors };
}

/** RFC 4180-ish CSV: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f.trim())) records.push(record);
      record = [];
    } else field += c;
  }
  record.push(field);
  if (record.some((f) => f.trim())) records.push(record);
  const [header, ...body] = records;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}
