/** A platform's active job posts (cached, with live stats) and their applicant lists. */
import { JobvisionSource, type JobPost } from '../infra/sources/jobvision-source';
import { criteriaFor } from './job-settings';
import { rawSourceConfig } from './sources-yaml';
import { db, jobvision, needToken, rowOut, source, state, UserError } from './state';

const JOBS_TTL_MS = 10 * 60_000;

/**
 * Active jobs of a platform. The list from the site is cached (DB) for 10 minutes; stats are always live.
 * `fresh` forces a refetch. If the site fails, the last cached list is returned with `error`.
 */
export async function listJobs(src: string, fresh = false) {
    const key = `jobs:${src}`;
    const cached = db().getKv<JobPost[]>(key);
    let list: JobPost[] | null = cached?.value ?? null;
    let fetchedAt = cached?.updatedAt ?? null;
    let error: string | null = null;
    if (fresh || !cached || Date.now() - new Date(cached.updatedAt).getTime() > JOBS_TTL_MS) {
        try {
            await needToken(src);
            list = await jobvision(src).listJobs();
            db().setKv(key, list);
            fetchedAt = new Date().toISOString();
        } catch (e) {
            if (!list) throw e;
            error = e instanceof Error ? e.message : String(e);
        }
    }
    const jobs = list ?? [];
    const stats = new Map(
        db()
            .jobStats(src)
            .map((x) => [x.job_id, x]),
    );
    const scheduled = new Set((rawSourceConfig(src).jobPostIds ?? []).map(String));
    for (const j of jobs)
        if (db().getJobMeta(src, j.id).title !== j.title) db().setJobMeta(src, j.id, { title: j.title });
    const enriched = jobs.map((j) => {
        const st = stats.get(j.id);
        return {
            ...j,
            criteriaKind: criteriaFor(src, j.id, j.title).kind,
            scheduled: scheduled.has(j.id),
            stats: st
                ? {
                      total: st.total,
                      accepted: st.accepted,
                      partial: st.partial,
                      rejected: st.rejected,
                      errors: st.errors,
                      pending: st.pending,
                      avgScore: st.avg_score,
                      lastProcessed: st.last_processed,
                  }
                : null,
            task: state().tasks.get(`${src}:${j.id}`) ?? null,
        };
    });
    return { jobs: enriched, fetchedAt, error };
}

/** Pull the current applicant list from the site into the DB (no scoring). */
export async function refreshApplications(src: string, jobId: string) {
    await needToken(src);
    const s = source(src);
    if (s instanceof JobvisionSource) s.onlyJobs = [Number(jobId)];
    const apps = await s.listApplications();
    for (const a of apps) db().upsertListed({ ...a, job: a.jobTitle });
    return { count: apps.length };
}

export function listApplications(src: string, jobId: string) {
    return db().listByJob(src, jobId).map(rowOut);
}

export function getApplication(src: string, id: string) {
    const r = db().get(src, id);
    if (!r) throw new UserError('رزومه پیدا نشد', 404);
    return { ...rowOut(r), resumeText: r.resume_text };
}
