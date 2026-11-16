/**
 * Everything the dashboard needs, on top of the existing CLI modules.
 * Runs inside the Next.js server process (Node runtime).
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { aiInfo, getChat, getScorer } from "./ai";
import { loadCriteria, pickCriteria } from "./criteria";
import { Db, type Row } from "./db";
import type { ChatMessage } from "./score";
import { loadSources, validateSourcesYaml } from "./sources/index";
import { AuthError } from "./sources/http-source";
import { JobvisionSource, type JobPost } from "./sources/jobvision-source";
import { credentials, ensureToken, hasCredentials, loginAndSave, saveCredentials, tokenInfo, tokenKey, writeEnv } from "./auth/token";
export { tokenInfo };
import { decisionOf, defaultPartial, type Application, type Criteria, type Source } from "./types";

const env = process.env;
const SOURCES_FILE = () => env.SOURCES_FILE || "sources.yaml";
const CRITERIA_DIR = () => env.CRITERIA_DIR || "criteria";

// ---------- singletons (survive Next.js dev reloads) ----------
const g = globalThis as unknown as { __ats?: { db: Db; tasks: Map<string, Task> } };
function state() {
  g.__ats ??= { db: new Db(env.DB_PATH || "data/ats.db"), tasks: new Map() };
  return g.__ats;
}
export const db = () => state().db;

export class UserError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

// ---------- platforms ----------
function sources(): Source[] {
  return loadSources(SOURCES_FILE());
}
function source(name: string): Source {
  const s = sources().find((x) => x.name === name);
  if (!s) throw new UserError(`پلتفرم «${name}» در sources.yaml فعال نیست`, 404);
  return s;
}
function jobvision(name: string): JobvisionSource {
  const s = source(name);
  if (!(s instanceof JobvisionSource)) throw new UserError(`${name} یک منبع جاب‌ویژن نیست`);
  return s;
}
export function status() {
  let platforms: { name: string; type: string; token: ReturnType<typeof tokenInfo> }[] = [];
  let sourcesError: string | null = null;
  try {
    platforms = sources().map((s) => ({
      name: s.name, type: s instanceof JobvisionSource ? "jobvision" : "other", token: tokenInfo(s.name),
      autoLogin: { email: credentials(s.name).email, hasPassword: !!credentials(s.name).password },
    }));
  } catch (e) {
    sourcesError = e instanceof Error ? e.message : String(e);
  }
  return { ai: aiInfo(), telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), platforms, sourcesError };
}

export function setCredentials(src: string, email: string, password?: string) {
  if (!email.trim()) throw new UserError("ایمیل خالی است");
  saveCredentials(src, email, password || undefined);
  return { email: credentials(src).email, hasPassword: !!credentials(src).password };
}

/** Log in with the saved email/password and store the new token. */
export async function loginNow(src: string, show = false) {
  if (!hasCredentials(src)) throw new UserError("اول ایمیل و رمز عبور را ذخیره کنید");
  const log: string[] = [];
  try {
    await loginAndSave(src, { show, log: (l) => log.push(l) });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  return { ...tokenInfo(src), log };
}

/** Make sure there is a valid token; logs in automatically if credentials are saved. */
async function needToken(src: string) {
  try {
    if (await ensureToken(src)) return;
  } catch (e) {
    throw new UserError(`ورود خودکار ناموفق بود: ${e instanceof Error ? e.message : e}`, 401);
  }
  throw new UserError(tokenInfo(src).hasToken ? "توکن منقضی شده. از «منابع و توکن‌ها» وارد شوید یا توکن جدید بدهید." : "توکن وارد نشده. از «منابع و توکن‌ها» ایمیل و رمز را ذخیره کنید.", 401);
}

export function setToken(src: string, token: string) {
  const tok = token.trim();
  if (!tok) throw new UserError("توکن خالی است");
  if (/[^\x21-\x7e ]/.test(tok)) throw new UserError("توکن کاراکتر نامعتبر دارد (مثلاً «…»). احتمالاً ناقص کپی شده؛ مقدار کامل را کپی کنید.");
  const raw = tok.replace(/^Bearer\s+/i, "");
  if (raw.split(".").length !== 3) throw new UserError("این مقدار شبیه یک توکن کامل نیست (باید ۳ بخش جدا شده با نقطه داشته باشد).");
  writeEnv(tokenKey(src), raw);
  return tokenInfo(src);
}

// ---------- sources.yaml ----------
export function readSourcesYaml() {
  const f = SOURCES_FILE();
  return { file: f, text: fs.existsSync(f) ? fs.readFileSync(f, "utf8") : fs.readFileSync("sources.example.yaml", "utf8"), exists: fs.existsSync(f) };
}
export function saveSourcesYaml(text: string) {
  const err = validateSourcesYaml(text);
  if (err) throw new UserError(`فایل معتبر نیست:\n${err}`);
  fs.writeFileSync(SOURCES_FILE(), text);
  return readSourcesYaml();
}

/** Raw (uninterpolated) config of one source from sources.yaml. */
function rawSourceConfig(src: string): any {
  const doc = YAML.parse(readSourcesYaml().text);
  return (doc?.sources ?? []).find((s: any) => s.name === src) ?? {};
}

/** Is this job included in scheduled/CLI runs (jobPostIds)? Toggle it, keeping comments. */
export function setJobScheduled(src: string, jobId: string, on: boolean) {
  const doc = YAML.parseDocument(readSourcesYaml().text);
  const list = doc.get("sources") as YAML.YAMLSeq | undefined;
  const item = list?.items.find((i: any) => i.get?.("name") === src) as YAML.YAMLMap | undefined;
  if (!item) throw new UserError(`${src} در sources.yaml نیست`);
  const ids = ((item.toJSON() as any).jobPostIds ?? []).map(Number).filter((x: number) => x !== Number(jobId));
  if (on) ids.push(Number(jobId));
  item.set("jobPostIds", doc.createNode(ids, { flow: true }));
  saveSourcesYaml(doc.toString());
}

// ---------- criteria (per job) ----------
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
  instructions: z.string().default(""),
});
export type CriteriaInput = z.infer<typeof CriteriaInput>;

function criteriaFor(src: string, jobId: string, jobTitle?: string): { criteria: Criteria | undefined; kind: "job" | "matched" | "default" | "none" } {
  const all = loadCriteria(CRITERIA_DIR());
  const own = all.find((c) => c.name === `job-${jobId}`);
  if (own) return { criteria: own, kind: "job" };
  const c = pickCriteria(all, { source: src, id: "", name: "", jobId, jobTitle });
  if (!c) return { criteria: undefined, kind: "none" };
  return { criteria: c, kind: c.name === "default" ? "default" : "matched" };
}

/** Fetch the published ad text once and cache it (best effort). */
export async function fetchJobAd(src: string, jobId: string, force = false) {
  const meta = db().getJobMeta(src, jobId);
  if (meta.adText && !force) return { adText: meta.adText, adFetchedAt: meta.adFetchedAt };
  const s = source(src);
  if (!(s instanceof JobvisionSource)) return { adText: "", adFetchedAt: null };
  try {
    const text = await s.getJobAd(jobId);
    db().setJobMeta(src, jobId, { ad_text: text, ad_fetched_at: new Date().toISOString() });
    return { adText: text, adFetchedAt: new Date().toISOString() };
  } catch (e) {
    if (force) throw new UserError(`دریافت متن آگهی ناموفق بود: ${e instanceof Error ? e.message : e}. می‌توانید متن آگهی را در «توضیح شغل» بنویسید یا کپی کنید.`, 502);
    db().setJobMeta(src, jobId, { ad_fetched_at: `failed ${new Date().toISOString()}` });
    return { adText: "", adFetchedAt: null };
  }
}

/** Everything known about a job, for the AI (chat, scoring, criteria drafts). */
async function jobContext(src: string, jobId: string) {
  let meta = db().getJobMeta(src, jobId);
  // try fetching the ad automatically once a day at most
  const lastTry = meta.adFetchedAt?.replace(/^failed /, "");
  if (!meta.adText && (!lastTry || Date.now() - new Date(lastTry).getTime() > 86_400_000)) {
    await fetchJobAd(src, jobId).catch(() => {});
    meta = db().getJobMeta(src, jobId);
  }
  const rows = db().listByJob(src, jobId);
  const title = meta.title || rows.find((r) => r.job)?.job || `آگهی ${jobId}`;
  const { criteria } = criteriaFor(src, jobId, title);
  return { title, meta, criteria, rows };
}

function jobContextText(ctx: Awaited<ReturnType<typeof jobContext>>) {
  const c = ctx.criteria;
  return [
    `عنوان شغل: ${ctx.title}`,
    ctx.meta.unit && `واحد: ${ctx.meta.unit}`,
    ctx.meta.adText && `متن آگهیِ منتشرشده:\n${ctx.meta.adText.slice(0, 6000)}`,
    ctx.meta.description && `توضیحات کارفرما دربارهٔ این شغل:\n${ctx.meta.description.slice(0, 4000)}`,
    c
      ? `شرایط غربالگری: حداقل امتیاز قبولی ${c.threshold}؛ تایید نسبی از ${c.partialThreshold}؛ الزامی: ${c.mustHave.join("، ") || "-"}؛ امتیاز اضافه: ${c.niceToHave.join("، ") || "-"}${c.hardFilters.minYears != null ? `؛ حداقل سابقه ${c.hardFilters.minYears} سال` : ""}${c.instructions ? `\nتوضیحات غربالگری: ${c.instructions}` : ""}`
      : "شرایط غربالگری هنوز ذخیره نشده.",
  ].filter(Boolean).join("\n\n");
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
      ? { threshold: criteria.threshold, partialThreshold: criteria.partialThreshold, mustHave: criteria.mustHave, niceToHave: criteria.niceToHave, hardFilters: { minYears: criteria.hardFilters.minYears ?? null, requireAny: criteria.hardFilters.requireAny ?? [], rejectIfAny: criteria.hardFilters.rejectIfAny ?? [] }, instructions: criteria.instructions ?? "" }
      : null,
    criteriaKind: kind,
    criteriaName: criteria?.name ?? null,
    scheduled: (cfg.jobPostIds ?? []).map(String).includes(String(jobId)),
    unit: db().getUnit(src, jobId),
    description: db().getJobMeta(src, jobId).description,
    adText: db().getJobMeta(src, jobId).adText,
    adFetchedAt: db().getJobMeta(src, jobId).adFetchedAt,
    sourceStatus: cfg.status ?? 10,
  };
}

export function saveJobCriteria(src: string, jobId: string, input: unknown, jobTitle?: string) {
  const c = CriteriaInput.parse(input);
  const doc = {
    name: `job-${jobId}`,
    match: { jobIds: [String(jobId)] },
    threshold: c.threshold,
    partialThreshold: Math.min(c.partialThreshold ?? defaultPartial(c.threshold), c.threshold),
    mustHave: c.mustHave,
    niceToHave: c.niceToHave,
    hardFilters: {
      ...(c.hardFilters.minYears != null ? { minYears: c.hardFilters.minYears } : {}),
      requireAny: c.hardFilters.requireAny,
      rejectIfAny: c.hardFilters.rejectIfAny,
    },
    instructions: c.instructions,
  };
  fs.mkdirSync(CRITERIA_DIR(), { recursive: true });
  fs.writeFileSync(jobCriteriaFile(jobId), `# ${jobTitle ?? ""} (${src} #${jobId}) - edited from the dashboard\n` + YAML.stringify(doc));
  return getJobSettings(src, jobId);
}

/** Turn the employer's plain-language description into criteria (not saved). */
export async function draftCriteria(src: string, jobId: string, jobTitle: string, description: string, current: CriteriaInput | null) {
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)");
  if (description.trim()) saveJobDescription(src, jobId, description);
  const ctx = await jobContext(src, jobId);
  if (!ctx.meta.adText && !ctx.meta.description) throw new UserError("متن آگهی دریافت نشد؛ شغل را در کادر توضیح بنویسید.");
  const system = `You turn an employer's plain description of a job into screening rules for an ATS in Iran.
Reply with ONE JSON object only:
{"threshold": number 0-100 (default 70; stricter if the employer sounds strict),
 "partialThreshold": number below threshold for "partial approval / maybe" candidates (default threshold-20),
 "mustHave": [short skill/experience phrases that are truly required, in the language candidates use in resumes - usually Persian, keep tool names in English],
 "niceToHave": [bonus phrases],
 "hardFilters": {"minYears": number|null, "requireAny": [], "rejectIfAny": []},
 "instructions": "clear Persian brief for the AI screener: what kind of person, priorities, what to penalize"}
Never add rules about gender, age, religion, ethnicity or marital status even if asked; mention this in instructions instead of encoding it.
Keep mustHave to the 3-6 most important items. Use hardFilters only for things the employer says are absolute.`;
  const user = `JOB TITLE: ${jobTitle || ctx.title}
${ctx.meta.adText ? `PUBLISHED JOB AD:\n${ctx.meta.adText.slice(0, 6000)}\n` : ""}${current ? `CURRENT RULES (update them, keep what the employer did not change): ${JSON.stringify(current)}\n` : ""}${ctx.meta.description ? `EMPLOYER SAYS (most important, overrides the ad):\n${ctx.meta.description}` : "Base the rules on the published ad."}`;
  const raw = await chat(system, [{ role: "user", content: user }], 1500);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return CriteriaInput.parse(JSON.parse(json));
}

// ---------- jobs & applications ----------
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
  const stats = new Map(db().jobStats(src).map((x) => [x.job_id, x]));
  const scheduled = new Set((rawSourceConfig(src).jobPostIds ?? []).map(String));
  for (const j of jobs) if (db().getJobMeta(src, j.id).title !== j.title) db().setJobMeta(src, j.id, { title: j.title });
  const enriched = jobs.map((j) => {
    const st = stats.get(j.id);
    return {
      ...j,
      criteriaKind: criteriaFor(src, j.id, j.title).kind,
      scheduled: scheduled.has(j.id),
      stats: st ? { total: st.total, accepted: st.accepted, partial: st.partial, rejected: st.rejected, errors: st.errors, pending: st.pending, avgScore: st.avg_score, lastProcessed: st.last_processed } : null,
      task: state().tasks.get(`${src}:${j.id}`) ?? null,
    };
  });
  return { jobs: enriched, fetchedAt, error };
}

const parse = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const rowOut = (r: Row) => ({
  id: r.id, name: r.name, job: r.job, jobId: r.job_id, decision: r.decision, score: r.score, error: r.error,
  result: parse(r.result_json), extra: parse(r.extra_json), profileUrl: r.profile_url, appliedAt: r.applied_at,
  processedAt: r.decision === "pending" ? null : r.processed_at,
});

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
  if (!r) throw new UserError("رزومه پیدا نشد", 404);
  return { ...rowOut(r), resumeText: r.resume_text };
}

// ---------- scoring tasks ----------
export interface Task {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  log: string[];
  errors: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** set by cancelScoring(); the run stops before the next resume */
  cancelRequested?: boolean;
  cancelled?: boolean;
}

/** Stop a running scoring run. The resume being scored right now finishes; the rest are skipped. */
export function cancelScoring(src: string, jobId: string): Task {
  const task = state().tasks.get(`${src}:${jobId}`);
  if (!task?.running) throw new UserError("امتیازدهی در حال اجرایی برای این آگهی وجود ندارد", 409);
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
export async function startScoring(src: string, jobId: string, opts: { ids?: string[]; rescore?: boolean }) {
  const key = `${src}:${jobId}`;
  if (state().tasks.get(key)?.running) throw new UserError("امتیازدهی این آگهی در حال اجراست", 409);
  await needToken(src);
  let s = source(src);
  const rows = db().listByJob(src, jobId);
  const targets = rows.filter((r) => (opts.ids ? opts.ids.includes(r.id) : true)).filter((r) => opts.rescore || r.decision === "pending" || r.decision === "error");
  const ctx = await jobContext(src, jobId);
  const base = ctx.criteria;
  if (!base) throw new UserError("اول در بخش تنظیمات، شرایط این آگهی را تعریف کنید.");
  // give the scorer the ad + employer description too
  const extraCtx = [ctx.meta.adText && `متن آگهی:\n${ctx.meta.adText.slice(0, 4000)}`, ctx.meta.description && `توضیحات کارفرما:\n${ctx.meta.description.slice(0, 3000)}`].filter(Boolean).join("\n\n");
  const criteria = extraCtx ? { ...base, instructions: [base.instructions, extraCtx].filter(Boolean).join("\n\n") } : base;
  if (!targets.length) throw new UserError(opts.ids ? "رزومه‌های انتخاب‌شده قبلاً امتیاز گرفته‌اند. برای امتیازدهی دوباره «امتیاز مجدد» را بزنید." : "رزومهٔ جدیدی برای امتیازدهی نیست.");

  const task: Task = { running: true, done: 0, total: targets.length, current: null, log: [], errors: 0, startedAt: new Date().toISOString() };
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
        source: src, id: r.id, name: r.name, jobId: r.job_id ?? jobId, jobTitle: r.job ?? undefined,
        profileUrl: r.profile_url ?? undefined, resumeUrl: r.resume_url ?? undefined, appliedAt: r.applied_at ?? undefined, extra: parse(r.extra_json) ?? undefined,
      };
      try {
        const text = s.getResumeText ? await s.getResumeText(app) : "";
        if (text.length < 50) throw new Error("متن رزومه خالی است");
        const res = await scorer.score(app, text, criteria);
        db().save({ source: src, id: app.id, name: app.name, job: app.jobTitle, jobId: app.jobId, decision: decisionOf(res), score: res.score, result: res, resumeText: text, extra: app.extra, profileUrl: app.profileUrl, resumeUrl: app.resumeUrl, appliedAt: app.appliedAt });
        log(`${app.name}: ${res.score}`);
      } catch (e) {
        // token expired mid-run: log in again once and retry this resume
        if (e instanceof AuthError && !relogged && hasCredentials(src)) {
          relogged = true;
          log("توکن منقضی شد؛ ورود دوباره…");
          try {
            await ensureToken(src, { force: true });
            s = source(src);
            i--;
            continue;
          } catch (le) {
            log(`✖ ورود دوباره ناموفق: ${le instanceof Error ? le.message : le}`);
          }
        }
        const msg = e instanceof Error ? e.message : String(e);
        task.errors++;
        log(`✖ ${app.name}: ${msg}`);
        db().save({ source: src, id: app.id, name: app.name, job: app.jobTitle, jobId: app.jobId, decision: "error", error: msg });
        if (e instanceof AuthError) {
          task.error = "توکن منقضی شده؛ توکن جدید وارد کنید.";
          break;
        }
      }
      task.done++;
    }
  })()
    .catch((e) => (task.error = e instanceof Error ? e.message : String(e)))
    .finally(() => {
      task.running = false;
      task.current = null;
      task.finishedAt = new Date().toISOString();
    });
  return task;
}

// ---------- employer chat ----------
function candidateLine(r: Row) {
  const res = parse(r.result_json);
  const ex = parse(r.extra_json) ?? {};
  const base = `- ${r.name} | وضعیت: ${STATUS_FA[r.decision] ?? r.decision}${r.score != null ? ` | امتیاز: ${r.score}` : ""} | سابقه: ${ex.totalWorkExperienceYears ?? "?"} سال | آخرین شغل: ${ex.lastJob ?? "-"} | شهر: ${ex.city ?? "-"} | حقوق درخواستی: ${ex.requestedSalary ?? "-"}`;
  if (!res) return base;
  return `${base}\n  خلاصه: ${res.summary}\n  نقاط قوت: ${(res.matched ?? []).join("، ")}\n  نقاط ضعف: ${(res.missing ?? []).join("، ")}${res.redFlags?.length ? `\n  هشدارها: ${res.redFlags.join("، ")}` : ""}`;
}

export function getChatHistory(src: string, jobId: string) {
  return db().getChat(src, jobId);
}
export function clearChat(src: string, jobId: string) {
  db().saveChat(src, jobId, []);
}

export async function chatAboutJob(src: string, jobId: string, message: string, focusIds: string[] = []) {
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)");
  if (!message.trim()) throw new UserError("پیام خالی است");
  const ctx = await jobContext(src, jobId);
  const rows = ctx.rows;

  // full resumes for selected candidates and anyone named in the message
  const named = rows.filter((r) => focusIds.includes(r.id) || (r.name && r.name.split(/\s+/).some((p) => p.length > 2 && message.includes(p))));
  let budget = 60_000;
  const resumes: string[] = [];
  for (const r of named) {
    if (!r.resume_text || budget <= 0) continue;
    const t = r.resume_text.slice(0, Math.min(12_000, budget));
    budget -= t.length;
    resumes.push(`### رزومهٔ کامل ${r.name} (id ${r.id})\n${t}`);
  }

  const n = (d: string) => rows.filter((r) => r.decision === d).length;
  const scored = rows.filter((r) => r.decision === "accepted" || r.decision === "partial" || r.decision === "rejected");
  const avg = scored.length ? Math.round(scored.reduce((x, r) => x + (r.score ?? 0), 0) / scored.length) : null;

  const system = `تو دستیار استخدام یک کارفرما هستی و دربارهٔ یک آگهی شغلی و رزومه‌های دریافتی آن با او گفتگو می‌کنی.
همهٔ اطلاعات آگهی و خلاصهٔ همهٔ رزومه‌ها در ادامه آمده است؛ این‌ها را از قبل می‌دانی، پس از کارفرما نخواه شغل یا شرایط را دوباره توضیح دهد.
همیشه به فارسی، کوتاه، دقیق و کاربردی جواب بده. فقط بر اساس همین اطلاعات حرف بزن و اگر چیزی را نمی‌دانی صادقانه بگو.
وقتی می‌پرسد چرا کسی پذیرفته یا رد شده، به نقاط قوت/ضعف و شرایط آگهی استناد کن. وقتی مقایسه می‌خواهد، فهرست یا جدول کوتاه بده.
جنسیت، سن، مذهب، قومیت و وضعیت تأهل را در قضاوت دخالت نده.

## آگهی
${jobContextText(ctx)}

## رزومه‌ها
تعداد کل: ${rows.length} · قبول: ${n("accepted")} · تایید نسبی: ${n("partial")} · رد: ${n("rejected")} · بررسی‌نشده: ${n("pending")} · خطا: ${n("error")}${avg != null ? ` · میانگین امتیاز: ${avg}` : ""}
${rows.slice(0, 200).map(candidateLine).join("\n")}

${resumes.length ? `## جزئیات رزومه‌های مورد بحث\n${resumes.join("\n\n")}` : ""}`;

  const history = db().getChat(src, jobId);
  const messages: ChatMessage[] = [...history.slice(-20), { role: "user", content: message }];
  const answer = await chat(system, messages, 2500);
  const saved = [...history, { role: "user" as const, content: message }, { role: "assistant" as const, content: answer }];
  db().saveChat(src, jobId, saved);
  return { answer, messages: saved };
}

// ---------- AI & Telegram settings (stored in .env, editable from the UI) ----------
const mask = (v?: string) => (v ? `${v.slice(0, 4)}…${v.slice(-4)}` : "");

export function getIntegrations() {
  return {
    ai: {
      provider: (env.AI_PROVIDER || (env.OMNIROUTE_BASE_URL ? "omniroute" : "")) as string,
      baseUrl: env.OMNIROUTE_BASE_URL ?? "",
      apiKeyMasked: mask(env.OMNIROUTE_API_KEY),
      hasApiKey: !!env.OMNIROUTE_API_KEY,
      model: env.OMNIROUTE_MODEL ?? "",
    },
    telegram: {
      tokenMasked: mask(env.TELEGRAM_BOT_TOKEN),
      hasToken: !!env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID ?? "",
      proxy: env.TELEGRAM_PROXY ?? "",
    },
  };
}

export function saveAiSettings(b: { baseUrl?: string; apiKey?: string; model?: string; enabled?: boolean }) {
  if (b.baseUrl !== undefined) {
    const u = b.baseUrl.trim();
    if (u && !/^https?:\/\//.test(u)) throw new UserError("آدرس باید با http:// یا https:// شروع شود");
    writeEnv("OMNIROUTE_BASE_URL", u);
  }
  if (b.apiKey) writeEnv("OMNIROUTE_API_KEY", b.apiKey.trim());
  if (b.model !== undefined) writeEnv("OMNIROUTE_MODEL", b.model.trim());
  if (b.enabled !== undefined) writeEnv("AI_PROVIDER", b.enabled ? "omniroute" : "keyword");
  return getIntegrations();
}

/** List models from the OpenAI-compatible /v1/models endpoint (uses typed values or saved ones). */
export async function listAiModels(b: { baseUrl?: string; apiKey?: string }) {
  const { httpFetch } = await import("./http");
  let base = (b.baseUrl || env.OMNIROUTE_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) throw new UserError("اول آدرس OmniRoute را وارد کنید");
  if (!/\/v\d+$/.test(base)) base += "/v1";
  const key = b.apiKey || env.OMNIROUTE_API_KEY || "";
  let res;
  try {
    res = await httpFetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} }, undefined, 20_000);
  } catch (e) {
    throw new UserError(`اتصال به ${base} برقرار نشد: ${e instanceof Error ? e.message : e}`, 502);
  }
  const text = await res.text();
  if (!res.ok) throw new UserError(`OmniRoute خطای ${res.status} داد: ${text.slice(0, 200)}`, 502);
  const json = JSON.parse(text);
  const ids: string[] = (json.data ?? json.models ?? []).map((m: any) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  return [...new Set(ids)].sort();
}

export async function testAi() {
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم یا فعال نشده");
  const started = Date.now();
  try {
    const answer = await chat("پاسخ را فقط به فارسی و در یک جمله بده.", [{ role: "user", content: "سلام، یک جملهٔ کوتاه بگو تا مطمئن شوم وصل هستی." }], 100);
    return { ok: true, answer: answer.trim(), ms: Date.now() - started, model: aiInfo().model };
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
}

export function saveTelegramSettings(b: { token?: string; chatId?: string; proxy?: string }) {
  if (b.token) {
    if (!/^\d+:[\w-]{20,}$/.test(b.token.trim())) throw new UserError("توکن ربات معتبر نیست (شکل درست: 123456:ABC...)");
    writeEnv("TELEGRAM_BOT_TOKEN", b.token.trim());
  }
  if (b.chatId !== undefined) writeEnv("TELEGRAM_CHAT_ID", b.chatId.trim());
  if (b.proxy !== undefined) writeEnv("TELEGRAM_PROXY", b.proxy.trim());
  return getIntegrations();
}

export async function testTelegram() {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new UserError("توکن ربات و شناسهٔ چت را وارد کنید");
  const { TelegramNotifier } = await import("./telegram");
  try {
    await new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.TELEGRAM_PROXY || undefined).sendText("✅ سامانهٔ جذب به تلگرام وصل شد.");
  } catch (e) {
    throw new UserError(`ارسال ناموفق: ${e instanceof Error ? e.message : e}`, 502);
  }
  return { ok: true };
}

// ---------- unit name & report ----------
export function setJobUnit(src: string, jobId: string, unit: string) {
  db().setUnit(src, jobId, unit.trim());
  return { unit: db().getUnit(src, jobId) };
}

const STATUS_FA: Record<string, string> = { accepted: "قبول", partial: "تایید نسبی", rejected: "رد", pending: "بررسی‌نشده", error: "خطا" };
const PLATFORM_FA: Record<string, string> = { jobvision: "جاب‌ویژن", jobinja: "جابینجا" };

export function report(src: string, q: { jobId?: string; status?: string; ids?: string }) {
  const decisions = q.status && q.status !== "all" ? q.status.split(",") : undefined;
  const ids = q.ids ? q.ids.split(",").filter(Boolean) : undefined;
  const rows = db().report(src, { jobId: q.jobId || undefined, decisions, ids });
  return {
    generatedAt: new Date().toISOString(),
    filter: { job: q.jobId ? rows[0]?.job ?? null : null, status: decisions?.map((d) => STATUS_FA[d] ?? d).join("، ") ?? "همه", selected: ids?.length ?? 0 },
    rows: rows.map((r) => {
      const ex = parse(r.extra_json) ?? {};
      return {
        name: r.name,
        source: PLATFORM_FA[r.source] ?? r.source,
        phone: r.phone ?? "",
        receivedAt: r.applied_at,
        unit: r.unit ?? "",
        jobTitle: r.job ?? "",
        resumeType: ex.resumeType ?? (r.resume_url ? "فایل رزومهٔ شخصی" : "پروفایل جاب‌ویژن"),
        status: STATUS_FA[r.decision] ?? r.decision,
        score: r.decision === "accepted" || r.decision === "partial" || r.decision === "rejected" ? r.score : null,
      };
    }),
  };
}
