/** The unit name per job, and the cross-job report feeding the "report" page and exports. */
import { db, parse, PLATFORM_FA, STATUS_FA } from './state';

export function setJobUnit(src: string, jobId: string, unit: string) {
  db().setUnit(src, jobId, unit.trim());
  return { unit: db().getUnit(src, jobId) };
}

export function report(src: string, q: { jobId?: string; status?: string; ids?: string }) {
  const decisions = q.status && q.status !== 'all' ? q.status.split(',') : undefined;
  const ids = q.ids ? q.ids.split(',').filter(Boolean) : undefined;
  const rows = db().report(src, { jobId: q.jobId || undefined, decisions, ids });
  return {
    generatedAt: new Date().toISOString(),
    filter: {
      job: q.jobId ? (rows[0]?.job ?? null) : null,
      status: decisions?.map((d) => STATUS_FA[d] ?? d).join('، ') ?? 'همه',
      selected: ids?.length ?? 0,
    },
    rows: rows.map((r) => {
      const ex = parse(r.extra_json) ?? {};
      return {
        name: r.name,
        source: PLATFORM_FA[r.source] ?? r.source,
        phone: r.phone ?? '',
        receivedAt: r.applied_at,
        unit: r.unit ?? '',
        jobTitle: r.job ?? '',
        resumeType: ex.resumeType ?? (r.resume_url ? 'فایل رزومهٔ شخصی' : 'پروفایل جاب‌ویژن'),
        status: STATUS_FA[r.decision] ?? r.decision,
        score:
          r.decision === 'accepted' || r.decision === 'partial' || r.decision === 'rejected'
            ? r.score
            : null,
      };
    }),
  };
}
