import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { isFilterKeyword } from './keywords';
import { defaultPartial, type Application, type Criteria } from './types';

const CriteriaSchema = z.object({
  name: z.string(),
  match: z
    .object({
      jobIds: z.array(z.coerce.string()).optional(),
      titleIncludes: z.array(z.string()).optional(),
    })
    .default({}),
  threshold: z.number().min(0).max(100).default(70),
  partialThreshold: z.number().min(0).max(100).optional(),
  mustHave: z.array(z.string()).default([]),
  niceToHave: z.array(z.string()).default([]),
  hardFilters: z
    .object({
      minYears: z.number().optional(),
      requireAny: z.array(z.string()).optional(),
      rejectIfAny: z.array(z.string()).optional(),
    })
    .default({}),
  instructions: z.string().optional(),
});

/**
 * Hard-filter fields are matched literally against the resume, so a descriptive sentence there would
 * reject everybody. Keep only short keywords and hand the sentences to the AI as instructions.
 */
export function tidyCriteria<T extends Criteria>(c: T): T {
  const hf = c.hardFilters ?? {};
  const split = (list?: string[]) => {
    const keep = (list ?? []).filter(isFilterKeyword);
    const moved = (list ?? []).filter((x) => !isFilterKeyword(x));
    return { keep, moved };
  };
  const req = split(hf.requireAny);
  const rej = split(hf.rejectIfAny);
  if (!req.moved.length && !rej.moved.length) return c;
  const notes = [
    req.moved.length ? `شرط‌های لازم (با قضاوت خودت بررسی کن): ${req.moved.join(' | ')}` : '',
    rej.moved.length
      ? `اگر این موارد صدق می‌کند امتیاز را پایین بیاور: ${rej.moved.join(' | ')}`
      : '',
  ].filter(Boolean);
  const instructions = [c.instructions?.trim(), ...notes].filter(Boolean).join('\n');
  return {
    ...c,
    hardFilters: { ...hf, requireAny: req.keep, rejectIfAny: rej.keep },
    instructions,
  };
}

export function loadCriteria(dir: string): Criteria[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const parsed = CriteriaSchema.safeParse(
        YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      );
      if (!parsed.success) throw new Error(`Invalid criteria file ${f}: ${parsed.error.message}`);
      const c = parsed.data;
      return tidyCriteria({
        ...c,
        partialThreshold: Math.min(c.partialThreshold ?? defaultPartial(c.threshold), c.threshold),
      } as Criteria);
    });
}

/** First criteria whose jobIds / titleIncludes match; falls back to one named "default". */
export function pickCriteria(all: Criteria[], app: Application): Criteria | undefined {
  const title = (app.jobTitle ?? '').toLowerCase();
  const hit = all.find(
    (c) =>
      (app.jobId && c.match.jobIds?.includes(String(app.jobId))) ||
      c.match.titleIncludes?.some((t) => title.includes(t.toLowerCase())),
  );
  return hit ?? all.find((c) => c.name === 'default');
}
