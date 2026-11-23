/** Running the scorer over a job's applicants in the background, and the follow-up automations after it. */
import { getScorer } from '../infra/ai';
import { AuthError } from '../infra/sources/http-source';
import { ensureToken, hasCredentials } from '../infra/auth/token';
import { decisionOf, type Application } from '../domain/types';
import { jobContext } from './job-settings';
import { autoSyncSheet } from './sheet-sync';
import { autoApplySiteStatuses } from './site-status';
import { autoRunTasks } from './data-tasks';
import { db, needToken, parse, source, state, type Task, UserError } from './state';

/** Stop a running scoring run. The resume being scored right now finishes; the rest are skipped. */
export function cancelScoring(src: string, jobId: string): Task {
      const task = state().tasks.get(`${src}:${jobId}`);
      if (!task?.running)
            throw new UserError('امتیازدهی در حال اجرایی برای این آگهی وجود ندارد', 409);
      task.cancelRequested = true;
      return task;
}

/** Number of scoring runs in progress (the auto-updater waits until it is 0). */
export function busyTasks(): number {
      return [...state().tasks.values()].filter((t) => t.running).length;
}

export function getTask(src: string, jobId: string): Task | null {
      return state().tasks.get(`${src}:${jobId}`) ?? null;
}

/** Score some (ids) or all applicants of a job in the background. */
export async function startScoring(
      src: string,
      jobId: string,
      opts: { ids?: string[]; rescore?: boolean },
) {
      const key = `${src}:${jobId}`;
      if (state().tasks.get(key)?.running)
            throw new UserError('امتیازدهی این آگهی در حال اجراست', 409);
      await needToken(src);
      let s = source(src);
      const rows = db().listByJob(src, jobId);
      const targets = rows
            .filter((r) => (opts.ids ? opts.ids.includes(r.id) : true))
            .filter((r) => opts.rescore || r.decision === 'pending' || r.decision === 'error');
      const ctx = await jobContext(src, jobId);
      const base = ctx.criteria;
      if (!base) throw new UserError('اول در بخش تنظیمات، شرایط این آگهی را تعریف کنید.');
      // give the scorer the ad + employer description too
      const extraCtx = [
            ctx.meta.adText && `متن آگهی:\n${ctx.meta.adText.slice(0, 4000)}`,
            ctx.meta.description && `توضیحات کارفرما:\n${ctx.meta.description.slice(0, 3000)}`,
      ]
            .filter(Boolean)
            .join('\n\n');
      const criteria = extraCtx
            ? { ...base, instructions: [base.instructions, extraCtx].filter(Boolean).join('\n\n') }
            : base;
      if (!targets.length)
            throw new UserError(
                  opts.ids
                        ? 'رزومه‌های انتخاب‌شده قبلاً امتیاز گرفته‌اند. برای امتیازدهی دوباره «امتیاز مجدد» را بزنید.'
                        : 'رزومهٔ جدیدی برای امتیازدهی نیست.',
            );

      const task: Task = {
            running: true,
            done: 0,
            total: targets.length,
            current: null,
            log: [],
            errors: 0,
            startedAt: new Date().toISOString(),
      };
      state().tasks.set(key, task);
      const scorer = getScorer();
      const log = (l: string) => {
            task.log.push(l);
            if (task.log.length > 200) task.log.shift();
      };

      (async () => {
            let relogged = false;
            for (let i = 0; i < targets.length; i++) {
                  if (task.cancelRequested) {
                        task.cancelled = true;
                        log(`متوقف شد (${task.done} از ${task.total})`);
                        break;
                  }
                  const r = targets[i];
                  task.current = r.name;
                  const app: Application = {
                        source: src,
                        id: r.id,
                        name: r.name,
                        jobId: r.job_id ?? jobId,
                        jobTitle: r.job ?? undefined,
                        profileUrl: r.profile_url ?? undefined,
                        resumeUrl: r.resume_url ?? undefined,
                        appliedAt: r.applied_at ?? undefined,
                        extra: parse(r.extra_json) ?? undefined,
                  };
                  try {
                        const text = s.getResumeText ? await s.getResumeText(app) : '';
                        if (text.length < 50) throw new Error('متن رزومه خالی است');
                        const res = await scorer.score(app, text, criteria);
                        db().save({
                              source: src,
                              id: app.id,
                              name: app.name,
                              job: app.jobTitle,
                              jobId: app.jobId,
                              decision: decisionOf(res),
                              score: res.score,
                              result: res,
                              resumeText: text,
                              extra: app.extra,
                              profileUrl: app.profileUrl,
                              resumeUrl: app.resumeUrl,
                              appliedAt: app.appliedAt,
                        });
                        log(`${app.name}: ${res.score}`);
                  } catch (e) {
                        // token expired mid-run: log in again once and retry this resume
                        if (e instanceof AuthError && !relogged && hasCredentials(src)) {
                              relogged = true;
                              log('توکن منقضی شد؛ ورود دوباره…');
                              try {
                                    await ensureToken(src, { force: true });
                                    s = source(src);
                                    i--;
                                    continue;
                              } catch (le) {
                                    log(
                                          `✖ ورود دوباره ناموفق: ${le instanceof Error ? le.message : le}`,
                                    );
                              }
                        }
                        const msg = e instanceof Error ? e.message : String(e);
                        task.errors++;
                        log(`✖ ${app.name}: ${msg}`);
                        db().save({
                              source: src,
                              id: app.id,
                              name: app.name,
                              job: app.jobTitle,
                              jobId: app.jobId,
                              decision: 'error',
                              error: msg,
                        });
                        if (e instanceof AuthError) {
                              task.error = 'توکن منقضی شده؛ توکن جدید وارد کنید.';
                              break;
                        }
                  }
                  task.done++;
            }
      })()
            .catch((e) => (task.error = e instanceof Error ? e.message : String(e)))
            .then(() => autoApplySiteStatuses(src, jobId, log))
            .then(() => autoSyncSheet(src, jobId, log))
            .then(() => autoRunTasks(src, jobId, log))
            .finally(() => {
                  task.running = false;
                  task.current = null;
                  task.finishedAt = new Date().toISOString();
            });
      return task;
}
