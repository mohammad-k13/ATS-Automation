import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Application, Criteria } from "./types";

const CriteriaSchema = z.object({
  name: z.string(),
  match: z.object({ jobIds: z.array(z.coerce.string()).optional(), titleIncludes: z.array(z.string()).optional() }).default({}),
  threshold: z.number().min(0).max(100).default(70),
  mustHave: z.array(z.string()).default([]),
  niceToHave: z.array(z.string()).default([]),
  hardFilters: z
    .object({ minYears: z.number().optional(), requireAny: z.array(z.string()).optional(), rejectIfAny: z.array(z.string()).optional() })
    .default({}),
  instructions: z.string().optional(),
});

export function loadCriteria(dir: string): Criteria[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const parsed = CriteriaSchema.safeParse(YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`Invalid criteria file ${f}: ${parsed.error.message}`);
      return parsed.data as Criteria;
    });
}

/** First criteria whose jobIds / titleIncludes match; falls back to one named "default". */
export function pickCriteria(all: Criteria[], app: Application): Criteria | undefined {
  const title = (app.jobTitle ?? "").toLowerCase();
  const hit = all.find(
    (c) =>
      (app.jobId && c.match.jobIds?.includes(String(app.jobId))) ||
      c.match.titleIncludes?.some((t) => title.includes(t.toLowerCase())),
  );
  return hit ?? all.find((c) => c.name === "default");
}
