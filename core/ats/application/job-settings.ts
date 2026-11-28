/** Per-job criteria (screening rules), the job's cached ad/description, and AI-drafting criteria from them. */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { getChat } from '../infra/ai';
import { loadCriteria, pickCriteria, tidyCriteria } from '../domain/criteria';
import { JobvisionSource } from '../infra/sources/jobvision-source';
import { defaultPartial, type Criteria } from '../domain/types';
import { getStatusMap } from './site-status';
import { rawSourceConfig } from './sources-yaml';
import { CRITERIA_DIR, db, source, UserError } from './state';

const jobCriteriaFile = (jobId: string) => path.join(CRITERIA_DIR(), `job-${jobId}.yaml`);

export const CriteriaInput = z.object({
    threshold: z.coerce.number().min(0).max(100).default(70),
    partialThreshold: z.coerce.number().min(0).max(100).nullable().optional(),
    mustHave: z.array(z.string().trim().min(1)).default([]),
    niceToHave: z.array(z.string().trim().min(1)).default([]),
    hardFilters: z
        .object({
            minYears: z.coerce.number().min(0).nullable().optional(),
            requireAny: z.array(z.string().trim().min(1)).default([]),
            rejectIfAny: z.array(z.string().trim().min(1)).default([]),
        })
        .default({ requireAny: [], rejectIfAny: [] }),
    instructions: z.string().default(''),
});
export type CriteriaInput = z.infer<typeof CriteriaInput>;

export function criteriaFor(
    src: string,
    jobId: string,
    jobTitle?: string,
): { criteria: Criteria | undefined; kind: 'job' | 'matched' | 'default' | 'none' } {
    const all = loadCriteria(CRITERIA_DIR());
    const own = all.find((c) => c.name === `job-${jobId}`);
    if (own) return { criteria: own, kind: 'job' };
    const c = pickCriteria(all, { source: src, id: '', name: '', jobId, jobTitle });
    if (!c) return { criteria: undefined, kind: 'none' };
    return { criteria: c, kind: c.name === 'default' ? 'default' : 'matched' };
}

/** Fetch the published ad text once and cache it (best effort). */
export async function fetchJobAd(src: string, jobId: string, force = false) {
    const meta = db().getJobMeta(src, jobId);
    if (meta.adText && !force) return { adText: meta.adText, adFetchedAt: meta.adFetchedAt };
    const s = source(src);
    if (!(s instanceof JobvisionSource)) return { adText: '', adFetchedAt: null };
    try {
        const text = await s.getJobAd(jobId);
        db().setJobMeta(src, jobId, { ad_text: text, ad_fetched_at: new Date().toISOString() });
        return { adText: text, adFetchedAt: new Date().toISOString() };
    } catch (e) {
        if (force)
            throw new UserError(
                `دریافت متن آگهی ناموفق بود: ${e instanceof Error ? e.message : e}. می‌توانید متن آگهی را در «توضیح شغل» بنویسید یا کپی کنید.`,
                502,
            );
        db().setJobMeta(src, jobId, { ad_fetched_at: `failed ${new Date().toISOString()}` });
        return { adText: '', adFetchedAt: null };
    }
}

/** Everything known about a job, for the AI (chat, scoring, criteria drafts). */
export async function jobContext(src: string, jobId: string) {
    let meta = db().getJobMeta(src, jobId);
    // try fetching the ad automatically once a day at most
    const lastTry = meta.adFetchedAt?.replace(/^failed /, '');
    if (!meta.adText && (!lastTry || Date.now() - new Date(lastTry).getTime() > 86_400_000)) {
        await fetchJobAd(src, jobId).catch(() => {});
        meta = db().getJobMeta(src, jobId);
    }
    const rows = db().listByJob(src, jobId);
    const title = meta.title || rows.find((r) => r.job)?.job || `آگهی ${jobId}`;
    const { criteria } = criteriaFor(src, jobId, title);
    return { title, meta, criteria, rows };
}

export function jobContextText(ctx: Awaited<ReturnType<typeof jobContext>>) {
    const c = ctx.criteria;
    return [
        `عنوان شغل: ${ctx.title}`,
        ctx.meta.unit && `واحد: ${ctx.meta.unit}`,
        ctx.meta.adText && `متن آگهیِ منتشرشده:\n${ctx.meta.adText.slice(0, 6000)}`,
        ctx.meta.description && `توضیحات کارفرما دربارهٔ این شغل:\n${ctx.meta.description.slice(0, 4000)}`,
        c
            ? `شرایط غربالگری: حداقل امتیاز قبولی ${c.threshold}؛ تایید نسبی از ${c.partialThreshold}؛ الزامی: ${c.mustHave.join('، ') || '-'}؛ امتیاز اضافه: ${c.niceToHave.join('، ') || '-'}${c.hardFilters.minYears != null ? `؛ حداقل سابقه ${c.hardFilters.minYears} سال` : ''}${c.instructions ? `\nتوضیحات غربالگری: ${c.instructions}` : ''}`
            : 'شرایط غربالگری هنوز ذخیره نشده.',
    ]
        .filter(Boolean)
        .join('\n\n');
}

export function saveJobDescription(src: string, jobId: string, description: string) {
    db().setJobMeta(src, jobId, { description: description.trim() });
    return { description: description.trim() };
}

export function getJobSettings(src: string, jobId: string) {
    const { criteria, kind } = criteriaFor(src, jobId);
    const cfg = rawSourceConfig(src);
    return {
        criteria: criteria
            ? {
                  threshold: criteria.threshold,
                  partialThreshold: criteria.partialThreshold,
                  mustHave: criteria.mustHave,
                  niceToHave: criteria.niceToHave,
                  hardFilters: {
                      minYears: criteria.hardFilters.minYears ?? null,
                      requireAny: criteria.hardFilters.requireAny ?? [],
                      rejectIfAny: criteria.hardFilters.rejectIfAny ?? [],
                  },
                  instructions: criteria.instructions ?? '',
              }
            : null,
        criteriaKind: kind,
        criteriaName: criteria?.name ?? null,
        scheduled: (cfg.jobPostIds ?? []).map(String).includes(String(jobId)),
        unit: db().getUnit(src, jobId),
        statusMap: getStatusMap(src, jobId),
        description: db().getJobMeta(src, jobId).description,
        adText: db().getJobMeta(src, jobId).adText,
        adFetchedAt: db().getJobMeta(src, jobId).adFetchedAt,
        sourceStatus: cfg.status ?? 10,
    };
}

export function saveJobCriteria(src: string, jobId: string, input: unknown, jobTitle?: string) {
    const parsed = CriteriaInput.parse(input);
    const c = tidyCriteria({
        ...parsed,
        name: `job-${jobId}`,
        match: {},
        partialThreshold: parsed.partialThreshold ?? defaultPartial(parsed.threshold),
        hardFilters: {
            minYears: parsed.hardFilters.minYears ?? undefined,
            requireAny: parsed.hardFilters.requireAny,
            rejectIfAny: parsed.hardFilters.rejectIfAny,
        },
    } as unknown as Criteria);
    const doc = {
        name: `job-${jobId}`,
        match: { jobIds: [String(jobId)] },
        threshold: c.threshold,
        partialThreshold: Math.min(c.partialThreshold, c.threshold),
        mustHave: c.mustHave,
        niceToHave: c.niceToHave,
        hardFilters: {
            ...(c.hardFilters.minYears != null ? { minYears: c.hardFilters.minYears } : {}),
            requireAny: c.hardFilters.requireAny ?? [],
            rejectIfAny: c.hardFilters.rejectIfAny ?? [],
        },
        instructions: c.instructions,
    };
    fs.mkdirSync(CRITERIA_DIR(), { recursive: true });
    fs.writeFileSync(
        jobCriteriaFile(jobId),
        `# ${jobTitle ?? ''} (${src} #${jobId}) - edited from the dashboard\n` + YAML.stringify(doc),
    );
    return getJobSettings(src, jobId);
}

/** Turn the employer's plain-language description into criteria (not saved). */
export async function draftCriteria(
    src: string,
    jobId: string,
    jobTitle: string,
    description: string,
    current: CriteriaInput | null,
) {
    const chat = getChat();
    if (!chat) throw new UserError('هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)');
    if (description.trim()) saveJobDescription(src, jobId, description);
    const ctx = await jobContext(src, jobId);
    if (!ctx.meta.adText && !ctx.meta.description)
        throw new UserError('متن آگهی دریافت نشد؛ شغل را در کادر توضیح بنویسید.');
    const system = `You turn an employer's plain description of a job into screening rules for an ATS in Iran.
Reply with ONE JSON object only:
{"threshold": number 0-100 (default 70; stricter if the employer sounds strict),
 "partialThreshold": number below threshold for "partial approval / maybe" candidates (default threshold-20),
 "mustHave": [short skill/experience phrases that are truly required, in the language candidates use in resumes - usually Persian, keep tool names in English],
 "niceToHave": [bonus phrases],
 "hardFilters": {"minYears": number|null, "requireAny": [], "rejectIfAny": []},
 // requireAny/rejectIfAny are matched LITERALLY against the resume text: only single words or 2-3 word terms
 // that a candidate would actually write (e.g. "نگهبانی", "انتظامات"). NEVER put sentences or conditions there —
 // those belong in "instructions". If in doubt, leave them empty.
 "instructions": "clear Persian brief for the AI screener: what kind of person, priorities, what to penalize"}
Never add rules about gender, age, religion, ethnicity or marital status even if asked; mention this in instructions instead of encoding it.
Keep mustHave to the 3-6 most important items. Use hardFilters only for things the employer says are absolute.`;
    const user = `JOB TITLE: ${jobTitle || ctx.title}
${ctx.meta.adText ? `PUBLISHED JOB AD:\n${ctx.meta.adText.slice(0, 6000)}\n` : ''}${current ? `CURRENT RULES (update them, keep what the employer did not change): ${JSON.stringify(current)}\n` : ''}${ctx.meta.description ? `EMPLOYER SAYS (most important, overrides the ad):\n${ctx.meta.description}` : 'Base the rules on the published ad.'}`;
    const raw = await chat(system, [{ role: 'user', content: user }], 1500);
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    return CriteriaInput.parse(JSON.parse(json));
}
