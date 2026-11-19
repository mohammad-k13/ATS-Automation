/** Mapping our decisions to Jobvision's own application-status codes, and applying it on the site. */
import { z } from 'zod';
import type { Row } from '../infra/db';
import { db, jobvision, needToken, parse, UserError } from './state';

/** Jobvision application statuses (BaseData/GetListOfApplicationStatuses). */
export const SITE_STATUSES = { 4: 'تایید اولیه', 6: 'در حال بررسی', 5: 'رد شده' } as const;
type SiteCode = 4 | 5 | 6;
const SITE_STATUS_NAME: Record<SiteCode, string> = { 4: 'approved', 6: 'checking', 5: 'rejected' };

export const StatusMap = z.object({
  accepted: z.union([z.literal(4), z.literal(5), z.literal(6), z.null()]).default(4),
  partial: z.union([z.literal(4), z.literal(5), z.literal(6), z.null()]).default(6),
  rejected: z.union([z.literal(4), z.literal(5), z.literal(6), z.null()]).default(5),
  auto: z.boolean().default(false),
});
export type StatusMap = z.infer<typeof StatusMap>;

export function getStatusMap(src: string, jobId: string): StatusMap {
  const raw = db().getJobMeta(src, jobId).siteStatusMap;
  return StatusMap.parse(raw ? JSON.parse(raw) : {});
}
export function saveStatusMap(src: string, jobId: string, input: unknown) {
  const m = StatusMap.parse(input);
  db().setJobMeta(src, jobId, { site_status_map: JSON.stringify(m) });
  return m;
}

/** What would change on Jobvision: people whose site status differs from what the map says. */
function statusPlan(src: string, jobId: string, ids?: string[]) {
  const map = getStatusMap(src, jobId);
  const groups = new Map<SiteCode, Row[]>();
  for (const r of db().listByJob(src, jobId)) {
    if (ids?.length && !ids.includes(r.id)) continue;
    const code = (map as any)[r.decision] as SiteCode | null | undefined;
    if (!code) continue; // pending / error / "don't change"
    if (r.site_status === SITE_STATUS_NAME[code]) continue; // already set
    groups.set(code, [...(groups.get(code) ?? []), r]);
  }
  return { map, groups };
}

export function previewSiteStatuses(src: string, jobId: string, ids?: string[]) {
  const { groups } = statusPlan(src, jobId, ids);
  return [...groups.entries()].map(([code, rows]) => ({
    code,
    label: SITE_STATUSES[code],
    count: rows.length,
    names: rows.slice(0, 10).map((r) => r.name),
  }));
}

/** Set the Jobvision status of everyone (or the given ids) according to the job's map. */
export async function applySiteStatuses(src: string, jobId: string, ids?: string[]) {
  await needToken(src);
  const { groups } = statusPlan(src, jobId, ids);
  const s = jobvision(src);
  const done: Record<string, number> = {};
  for (const [code, rows] of groups) {
    for (let i = 0; i < rows.length; i += 20) {
      const batch = rows.slice(i, i + 20);
      await s.changeStatus(
        jobId,
        batch.map((r) => ({ id: r.id, aiScore: parse(r.extra_json)?.jobvisionMatchScore ?? null })),
        code,
      );
      db().setSiteStatus(
        src,
        batch.map((r) => r.id),
        SITE_STATUS_NAME[code],
      );
    }
    done[SITE_STATUSES[code]] = rows.length;
  }
  return { done };
}

/** After a scoring run, when the job's map has auto on. Never throws. */
export async function autoApplySiteStatuses(src: string, jobId: string, log: (s: string) => void) {
  if (!getStatusMap(src, jobId).auto) return;
  try {
    const { done } = await applySiteStatuses(src, jobId);
    const parts = Object.entries(done).map(([k, v]) => `${v} نفر «${k}»`);
    if (parts.length) log(`جاب‌ویژن: ${parts.join('، ')}`);
  } catch (e) {
    log(`✖ تغییر وضعیت در جاب‌ویژن: ${e instanceof Error ? e.message : e}`);
  }
}

/** Reject on the job site itself (Jobvision status 5). */
export async function rejectOnSite(src: string, jobId: string, ids: string[]) {
  if (!ids.length) throw new UserError('کسی انتخاب نشده');
  await needToken(src);
  const rows = db()
    .listByJob(src, jobId)
    .filter((r) => ids.includes(r.id));
  const s = jobvision(src);
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    await s.changeStatus(
      jobId,
      batch.map((r) => ({ id: r.id, aiScore: parse(r.extra_json)?.jobvisionMatchScore ?? null })),
      5,
    );
    db().setSiteStatus(
      src,
      batch.map((r) => r.id),
      'rejected',
    );
  }
  return { rejected: rows.length };
}
