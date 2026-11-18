/**
 * Everything the dashboard needs, on top of the existing CLI modules.
 * Runs inside the Next.js server process (Node runtime).
 */
import fs from "node:fs";
import "./settings-store"; // saved dashboard settings override .env
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { zipSync } from "fflate";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { aiInfo, getChat, getScorer } from "./ai";
import { loadCriteria, pickCriteria, tidyCriteria } from "./criteria";
import { Db, type Row, type ThreadRow } from "./db";
import { EXPORT_INSTRUCTIONS, extractExports, fieldValue, jalaliDate, type ExportTable } from "./exports";
import { appsScript, callSheet, describeRule, MAPPING_PROMPT, normKey, RULE_PROMPT, ruleReason, SHEET_FIELDS, SheetRule } from "./gsheet";
import { buildCsv, describePlan, planPrompt, sanitizePlan, type SheetTab, type TaskPlan } from "./tasks";
import { buildXlsx } from "./xlsx";
import type { ChatMessage } from "./score";
import { loadSources, validateSourcesYaml } from "./sources/index";
import { AuthError } from "./sources/http-source";
import { fileAuthMemo, JobvisionSource, type JobPost } from "./sources/jobvision-source";
import { diagnoseAttachment } from "./auth/jobvision-diagnose";
import { credentials, ensureToken, hasCredentials, loginAndSave, saveCookies, savedCookies, saveCredentials, tokenInfo, tokenKey, writeEnv } from "./auth/token";
import * as remote from "./auth/remote-login";
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

// ---------- manual login from the dashboard (login page with a captcha) ----------
const remoteCall = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 409);
  }
};
export const remoteLogin = {
  start: (src: string) => {
    jobvision(src);
    return remoteCall(() =>
      remote.startRemoteLogin({
        src, email: credentials(src).email, cookies: savedCookies(src),
        onDone: (token, cookies) => {
          writeEnv(tokenKey(src), token);
          saveCookies(src, cookies);
        },
      }),
    );
  },
  status: (src: string) => ({ ...remote.status(src), token: tokenInfo(src) }),
  shot: (src: string) => remoteCall(() => remote.screenshot(src)),
  click: (src: string, x: number, y: number) => remoteCall(() => remote.click(src, Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))),
  type: (src: string, text: string) => remoteCall(() => remote.type(src, String(text).slice(0, 200))),
  key: (src: string, key: string) => remoteCall(() => remote.press(src, key)),
  cancel: (src: string) => remote.cancel(src),
};

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
    statusMap: getStatusMap(src, jobId),
    description: db().getJobMeta(src, jobId).description,
    adText: db().getJobMeta(src, jobId).adText,
    adFetchedAt: db().getJobMeta(src, jobId).adFetchedAt,
    sourceStatus: cfg.status ?? 10,
  };
}

export function saveJobCriteria(src: string, jobId: string, input: unknown, jobTitle?: string) {
  const parsed = CriteriaInput.parse(input);
  const c = tidyCriteria({ ...parsed, name: `job-${jobId}`, match: {}, partialThreshold: parsed.partialThreshold ?? defaultPartial(parsed.threshold), hardFilters: { minYears: parsed.hardFilters.minYears ?? undefined, requireAny: parsed.hardFilters.requireAny, rejectIfAny: parsed.hardFilters.rejectIfAny } } as unknown as Criteria);
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
 // requireAny/rejectIfAny are matched LITERALLY against the resume text: only single words or 2-3 word terms
 // that a candidate would actually write (e.g. "نگهبانی", "انتظامات"). NEVER put sentences or conditions there —
 // those belong in "instructions". If in doubt, leave them empty.
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
  siteStatus: r.site_status,
  sheetSyncedAt: r.gsheet_synced_at,
  hasAttachment: !!(parse(r.extra_json)?.personalCvFileId || r.resume_url),
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

// ---------- employer chat ----------
function candidateLine(r: Row) {
  const res = parse(r.result_json);
  const ex = parse(r.extra_json) ?? {};
  const base = `- ${r.name} | وضعیت: ${STATUS_FA[r.decision] ?? r.decision}${r.score != null ? ` | امتیاز: ${r.score}` : ""} | سابقه: ${ex.totalWorkExperienceYears ?? "?"} سال | آخرین شغل: ${ex.lastJob ?? "-"} | شهر: ${ex.city ?? "-"} | حقوق درخواستی: ${ex.requestedSalary ?? "-"}`;
  if (!res) return base;
  return `${base}\n  خلاصه: ${res.summary}\n  نقاط قوت: ${(res.matched ?? []).join("، ")}\n  نقاط ضعف: ${(res.missing ?? []).join("، ")}${res.redFlags?.length ? `\n  هشدارها: ${res.redFlags.join("، ")}` : ""}`;
}

// ---- conversations (threads). Messages may carry Excel exports built by the server.
export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  exports?: ExportTable[];
  at?: string;
}
const threadOut = (t: ThreadRow) => {
  const messages: ChatMsg[] = JSON.parse(t.messages_json);
  return { id: t.id, title: t.title, updatedAt: t.updated_at, count: messages.length, messages };
};
function ownThread(src: string, jobId: string, id: string) {
  const t = db().getThread(id);
  if (!t || t.source !== src || t.job_id !== jobId) throw new UserError("گفتگو پیدا نشد", 404);
  return t;
}

export function listThreads(src: string, jobId: string) {
  return db().listThreads(src, jobId).map((t) => {
    const { messages, ...rest } = threadOut(t);
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    return { ...rest, preview: (last?.content ?? messages[0]?.content ?? "").replace(/[#*|`>-]/g, " ").replace(/\s+/g, " ").slice(0, 90) };
  });
}
export function getThread(src: string, jobId: string, id: string) {
  return threadOut(ownThread(src, jobId, id));
}
export function createThread(src: string, jobId: string, title?: string) {
  return threadOut(db().createThread(src, jobId, title?.trim() || "گفتگوی جدید"));
}
export function renameThread(src: string, jobId: string, id: string, title: string) {
  ownThread(src, jobId, id);
  if (!title.trim()) throw new UserError("عنوان خالی است");
  db().saveThread(id, { title: title.trim().slice(0, 80) });
  return getThread(src, jobId, id);
}
export function deleteThread(src: string, jobId: string, id: string) {
  ownThread(src, jobId, id);
  db().deleteThread(id);
  return { ok: true };
}

/** What the AI should know from the job's other conversations (titles + recent turns). */
function otherThreadsText(src: string, jobId: string, exceptId: string | null): string {
  let budget = 10_000;
  const parts: string[] = [];
  for (const t of db().listThreads(src, jobId).filter((x) => x.id !== exceptId).slice(0, 12)) {
    const msgs: ChatMsg[] = JSON.parse(t.messages_json);
    if (!msgs.length) continue;
    const lines = msgs.slice(-6).map((m) => `${m.role === "user" ? "کارفرما" : "دستیار"}: ${m.content.replace(/\s+/g, " ").slice(0, 350)}${m.exports?.length ? ` [اکسل: ${m.exports.map((e) => e.title).join("، ")}]` : ""}`);
    const block = `### «${t.title}»\n${lines.join("\n")}`;
    if (block.length > budget) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.join("\n\n");
}

export async function chatInThread(src: string, jobId: string, threadId: string | null, message: string, focusIds: string[] = []) {
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)");
  if (!message.trim()) throw new UserError("پیام خالی است");
  const thread = threadId ? ownThread(src, jobId, threadId) : db().createThread(src, jobId, message.trim().replace(/\s+/g, " ").slice(0, 48));
  const history: ChatMsg[] = JSON.parse(thread.messages_json);

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
  const others = otherThreadsText(src, jobId, thread.id);

  const system = `تو دستیار استخدام یک کارفرما هستی و دربارهٔ یک آگهی شغلی و رزومه‌های دریافتی آن با او گفتگو می‌کنی.
همهٔ اطلاعات آگهی، خلاصهٔ همهٔ رزومه‌ها و گفتگوهای دیگرِ همین آگهی در ادامه آمده است؛ این‌ها را از قبل می‌دانی، پس از کارفرما نخواه چیزی را دوباره توضیح دهد.
همیشه به فارسی، دقیق و کاربردی جواب بده و از مارک‌داون استفاده کن (تیتر کوتاه، فهرست، **پررنگ**، جدول برای مقایسه). فقط بر اساس همین اطلاعات حرف بزن و اگر چیزی را نمی‌دانی صادقانه بگو.
وقتی می‌پرسد چرا کسی پذیرفته یا رد شده، به نقاط قوت/ضعف، هشدارها و شرایط آگهی استناد کن.
جنسیت، سن، مذهب، قومیت و وضعیت تأهل را در قضاوت دخالت نده.

## آگهی
${jobContextText(ctx)}

## رزومه‌ها (هر خط با [id:...] شروع می‌شود)
تعداد کل: ${rows.length} · قبول: ${n("accepted")} · تایید نسبی: ${n("partial")} · رد: ${n("rejected")} · بررسی‌نشده: ${n("pending")} · خطا: ${n("error")}${avg != null ? ` · میانگین امتیاز: ${avg}` : ""}
${rows.slice(0, 200).map((r) => `[id:${r.id}] ${candidateLine(r).replace(/^- /, "")}`).join("\n")}
${resumes.length ? `\n## جزئیات رزومه‌های مورد بحث\n${resumes.join("\n\n")}` : ""}
${others ? `\n## گفتگوهای دیگر کارفرما دربارهٔ همین آگهی (برای آگاهی؛ اگر لازم شد به آن‌ها اشاره کن)\n${others}` : ""}

${EXPORT_INSTRUCTIONS}`;

  const asText = (m: ChatMsg) => (m.exports?.length ? `${m.content}\n[فایل اکسل ساخته شد: ${m.exports.map((e) => `${e.title} (${e.rows.length} ردیف)`).join("، ")}]` : m.content);
  const turns: ChatMessage[] = [...history.slice(-20).map((m) => ({ role: m.role, content: asText(m) })), { role: "user", content: message }];
  const raw = await chat(system, turns, 3000);
  const { text, exports, errors } = extractExports(raw, rows, ctx.meta.unit);
  const answer = [text || (exports.length ? "فایل اکسل آماده است." : ""), errors.length ? `\n> ساخت اکسل ناموفق بود: ${errors.join("؛ ")}` : ""].join("").trim();
  const now = new Date().toISOString();
  const saved: ChatMsg[] = [...history, { role: "user", content: message, at: now }, { role: "assistant", content: answer, exports: exports.length ? exports : undefined, at: now }];
  db().saveThread(thread.id, { messages: saved });
  return getThread(src, jobId, thread.id);
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

// ---------- resume files, ZIP downloads, status on the job site ----------

const dataDir = () => path.dirname(path.resolve(env.DB_PATH || "data/ats.db"));
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "بی‌نام";

function rowApp(src: string, r: Row): Application {
  return {
    source: src, id: r.id, name: r.name, jobId: r.job_id ?? undefined, jobTitle: r.job ?? undefined,
    resumeUrl: r.resume_url ?? undefined, profileUrl: r.profile_url ?? undefined, extra: parse(r.extra_json) ?? undefined,
  };
}

/** Both files of one candidate (Jobvision PDF + attached file), cached on disk after the first download. */
async function candidateFiles(src: string, r: Row): Promise<{ files: { name: string; data: Uint8Array }[]; errors: string[] }> {
  const s = jobvision(src);
  const dir = path.join(dataDir(), "files", src, r.id);
  await fsp.mkdir(dir, { recursive: true });
  const cached = await fsp.readdir(dir).catch(() => [] as string[]);
  const files: { name: string; data: Uint8Array }[] = [];
  const errors: string[] = [];
  const app = rowApp(src, r);

  const jv = cached.find((f) => f.startsWith("رزومه جاب‌ویژن"));
  if (jv) files.push({ name: jv, data: await fsp.readFile(path.join(dir, jv)) });
  else
    try {
      const f = await s.downloadJobvisionCv(app);
      await fsp.writeFile(path.join(dir, f.filename), f.data);
      files.push({ name: f.filename, data: f.data });
    } catch (e) {
      if (e instanceof AuthError) throw e;
      errors.push(`رزومهٔ جاب‌ویژن: ${e instanceof Error ? e.message : e}`);
    }

  const att = cached.find((f) => f.startsWith("رزومه پیوست"));
  if (att) files.push({ name: att, data: await fsp.readFile(path.join(dir, att)) });
  else if (app.extra?.personalCvFileId || app.resumeUrl)
    try {
      const f = await s.downloadAttachedCv(app);
      if (f) {
        await fsp.writeFile(path.join(dir, f.filename), f.data);
        files.push({ name: f.filename, data: f.data });
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      errors.push(`فایل پیوست: ${e instanceof Error ? e.message : e}`);
    }
  return { files, errors };
}

export interface ZipTask {
  running: boolean; done: number; total: number; current: string | null;
  token?: string; filename?: string; errors: string[]; error?: string; startedAt: string;
}
const zipTasks = () => ((globalThis as any).__atsZipTasks ??= new Map<string, ZipTask>()) as Map<string, ZipTask>;
export const getZipTask = (src: string, jobId: string) => zipTasks().get(`${src}:${jobId}`) ?? null;

/** Build a ZIP of resumes in the background: selected ids, or everyone with the given decisions. */
export async function startZip(src: string, jobId: string, opts: { ids?: string[]; decisions?: string[] }) {
  const key = `${src}:${jobId}`;
  if (zipTasks().get(key)?.running) throw new UserError("ساخت فایل فشرده برای این آگهی در حال اجراست", 409);
  await needToken(src);
  const decisions = opts.decisions ?? ["accepted", "partial"];
  const rows = db().listByJob(src, jobId).filter((r) => (opts.ids?.length ? opts.ids.includes(r.id) : decisions.includes(r.decision)));
  if (!rows.length) throw new UserError(opts.ids?.length ? "رزومه‌ای انتخاب نشده" : "رزومهٔ قبول یا تایید نسبی وجود ندارد");
  const title = rows[0].job ?? `آگهی ${jobId}`;
  const task: ZipTask = { running: true, done: 0, total: rows.length, current: null, errors: [], startedAt: new Date().toISOString() };
  zipTasks().set(key, task);

  (async () => {
    const zip: Record<string, Uint8Array> = {};
    const STATUS: Record<string, string> = { accepted: "قبول", partial: "تایید نسبی", rejected: "رد", pending: "بررسی‌نشده", error: "خطا" };
    const index: (string | number)[][] = [];
    for (const [i, r] of rows.entries()) {
      task.current = r.name;
      const folder = safeName(`${String(i + 1).padStart(2, "0")} - ${r.name}${r.score != null ? ` - ${r.score}` : ""}`);
      try {
        const { files, errors } = await candidateFiles(src, r);
        for (const f of files) zip[`${folder}/${f.name}`] = f.data;
        for (const e of errors) task.errors.push(`${r.name}: ${e}`);
      } catch (e) {
        if (e instanceof AuthError) { task.error = "توکن منقضی شده؛ دوباره وارد شوید."; break; }
        task.errors.push(`${r.name}: ${e instanceof Error ? e.message : e}`);
      }
      index.push([i + 1, r.name, r.phone ?? "", STATUS[r.decision] ?? r.decision, r.score ?? "", jalaliDate(r.applied_at), folder]);
      task.done++;
    }
    zip["فهرست.xlsx"] = buildXlsx("فهرست", ["ردیف", "نام کارجو", "تلفن", "وضعیت", "امتیاز", "تاریخ دریافت", "پوشه"], index);
    const token = randomUUID();
    const dir = path.join(dataDir(), "exports");
    await fsp.mkdir(dir, { recursive: true });
    // keep only recent exports
    for (const f of await fsp.readdir(dir)) {
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 86_400_000) await fsp.rm(path.join(dir, f), { force: true });
    }
    await fsp.writeFile(path.join(dir, `${token}.zip`), zipSync(zip, { level: 0 }));
    task.token = token;
    task.filename = `${safeName(title)} - ${opts.ids?.length ? "انتخاب‌شده‌ها" : "قبول و نسبی"} - ${jalaliDate(new Date().toISOString()).replace(/\//g, "-")}.zip`;
  })()
    .catch((e) => (task.error = e instanceof Error ? e.message : String(e)))
    .finally(() => { task.running = false; task.current = null; });
  return task;
}

export async function zipFile(token: string): Promise<Uint8Array> {
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new UserError("not found", 404);
  return fsp.readFile(path.join(dataDir(), "exports", `${token}.zip`)).catch(() => { throw new UserError("فایل پیدا نشد یا منقضی شده", 404); });
}

/** Files of one candidate for the resume panel. */
export async function candidateFile(src: string, id: string, kind: "jobvision" | "attached") {
  const r = db().get(src, id);
  if (!r) throw new UserError("رزومه پیدا نشد", 404);
  await needToken(src);
  const { files, errors } = await candidateFiles(src, r);
  const f = files.find((x) => x.name.startsWith(kind === "jobvision" ? "رزومه جاب‌ویژن" : "رزومه پیوست"));
  if (!f) throw new UserError(errors.find((e) => e.startsWith(kind === "jobvision" ? "رزومهٔ جاب‌ویژن" : "فایل پیوست")) ?? "این کارجو فایل پیوست ندارد", 404);
  return { name: `${safeName(r.name)} - ${f.name}`, data: f.data };
}

/**
 * Fix for "attached resume gives 401": open the panel in a hidden browser on this server, click the
 * download icon like a person would, record what the browser sends (names only), keep the login
 * cookies, and retry our own download with them. Returns a report that is safe to share.
 */
export async function diagnoseAttachmentDownload(src: string) {
  await needToken(src);
  const s = jobvision(src);
  const row = db().list(5000).find((r) => r.source === src && parse(r.extra_json)?.personalCvFileId);
  if (!row) throw new UserError("هیچ کارجویی با فایل پیوست در پایگاه داده نیست؛ اول رزومه‌ها را دریافت کنید.");
  const app = rowApp(src, row);
  const links = s.attachmentLinks(app);
  const log: string[] = [];
  const { email, password } = credentials(src);
  let d;
  try {
    d = await diagnoseAttachment({
      email, password, token: process.env[tokenKey(src)] ?? "", panelBase: links.panelBase,
      profileUrl: links.profileUrl, fileUrl: links.fileUrl!, log: (l) => log.push(l),
    });
  } catch (e) {
    throw new UserError(`اجرای مرورگر ناموفق بود: ${e instanceof Error ? e.message : e}\n${log.join("\n")}`, 502);
  }
  saveCookies(src, d.cookies);
  fileAuthMemo.way = undefined;
  let retry: string;
  let fixed = false;
  try {
    const f = await jobvision(src).downloadAttachedCv(app);
    fixed = !!f;
    retry = f ? `موفق ✔ (${f.data.length.toLocaleString("en")} بایت، روش: ${fileAuthMemo.way})` : "فایلی برنگشت";
  } catch (e) {
    retry = `ناموفق: ${e instanceof Error ? e.message : e}`;
  }
  const report = [
    `ATS attachment diagnosis — ${new Date().toISOString()}`,
    `candidate: ${row.id}  job: ${row.job_id}`,
    `login: ${d.loggedInWith}  profile opened: ${d.profileOpened}  icon clicked: ${d.clicked}`,
    `direct tab open: status=${d.direct.status} type=${d.direct.contentType}`,
    `cookies saved: ${d.cookieNames.join(", ") || "none"}`,
    `retry with our downloader: ${retry}`,
    `file-related requests (${d.requests.length}):`,
    ...d.requests.slice(0, 30).map((r) => `  ${r.method} ${r.url}\n    status=${r.status} type=${r.contentType} bytes=${r.bytes}\n    headers: ${r.headers.join(", ")}\n    cookies: ${r.cookies.join(", ") || "-"}`),
    "log:",
    ...log.map((l) => `  ${l}`),
  ].join("\n");
  return { fixed, report };
}

/** The screenshot the last failed auto-login saved (to see what the login page showed). */
export function loginScreenshot(): Uint8Array {
  const f = path.join(dataDir(), "login-error.png");
  if (!fs.existsSync(f)) throw new UserError("تصویری ذخیره نشده", 404);
  return fs.readFileSync(f);
}

/** Reject on the job site itself (Jobvision status 5). */
export async function rejectOnSite(src: string, jobId: string, ids: string[]) {
  if (!ids.length) throw new UserError("کسی انتخاب نشده");
  await needToken(src);
  const rows = db().listByJob(src, jobId).filter((r) => ids.includes(r.id));
  const s = jobvision(src);
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    await s.changeStatus(jobId, batch.map((r) => ({ id: r.id, aiScore: parse(r.extra_json)?.jobvisionMatchScore ?? null })), 5);
    db().setSiteStatus(src, batch.map((r) => r.id), "rejected");
  }
  return { rejected: rows.length };
}

// ---------- Google Sheet sync ----------
export interface SheetConfig {
  url: string;
  sheet: string;
  headers: string[];
  mapping: Record<string, string | null>; // header -> field key
  keyColumn: string | null; // header used to recognise people already in the sheet
  conditionText: string;
  rule: SheetRule;
  autoSync: boolean;
}
const SHEET_KEY = "gsheet";
const sheetDefaults = (): SheetConfig => ({ url: "", sheet: "", headers: [], mapping: {}, keyColumn: null, conditionText: "", rule: SheetRule.parse({}), autoSync: false });
function sheetConfig(): SheetConfig {
  return { ...sheetDefaults(), ...(db().getKv<SheetConfig>(SHEET_KEY)?.value ?? {}) };
}
function sheetSecret(): string {
  if (!env.GSHEET_SECRET) writeEnv("GSHEET_SECRET", randomUUID().replace(/-/g, ""));
  return env.GSHEET_SECRET!;
}

export function getSheetSettings() {
  const c = sheetConfig();
  return { ...c, ruleText: describeRule(c.rule), script: appsScript(sheetSecret()), fields: SHEET_FIELDS };
}

export function saveSheetSettings(input: Partial<SheetConfig>) {
  const c = { ...sheetConfig(), ...input };
  if (input.rule) c.rule = SheetRule.parse(input.rule);
  if (c.keyColumn && c.headers.length && !c.headers.includes(c.keyColumn)) c.keyColumn = null;
  db().setKv(SHEET_KEY, c);
  return getSheetSettings();
}

/** Connect: read the sheet's tabs and header row (and remember them). */
export async function testSheet(input: { url?: string; sheet?: string }) {
  const c = sheetConfig();
  const url = (input.url ?? c.url).trim();
  if (!url) throw new UserError("آدرس Web app را وارد کنید");
  let info: { sheets: string[]; sheet: string; headers: string[]; rows: number; title: string };
  try {
    info = await callSheet(url, { secret: sheetSecret(), action: "info", sheet: input.sheet ?? c.sheet ?? "" });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  const headers = info.headers.map((h) => String(h).trim()).filter(Boolean);
  const mapping = Object.fromEntries(headers.map((h) => [h, c.mapping[h] ?? null]));
  saveSheetSettings({ url, sheet: info.sheet, headers, mapping });
  return { ...info, headers };
}

/** AI suggestion: which of our fields goes in which sheet column. Headers only, no personal data. */
export async function suggestSheetMapping() {
  const c = sheetConfig();
  if (!c.headers.length) throw new UserError("اول اتصال را آزمایش کنید تا ستون‌های شیت خوانده شود");
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده");
  const raw = await chat(MAPPING_PROMPT, [{ role: "user", content: `HEADERS: ${JSON.stringify(c.headers)}` }], 1000);
  const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const mapping = Object.fromEntries(c.headers.map((h) => [h, typeof json[h] === "string" && json[h] in SHEET_FIELDS ? json[h] : null]));
  const keyColumn = c.keyColumn ?? c.headers.find((h) => mapping[h] === "phone") ?? null;
  return saveSheetSettings({ mapping, keyColumn });
}

/** Turn the plain-language condition into a rule (not saved until the user confirms). */
export async function sheetRuleFromText(text: string) {
  if (!text.trim()) throw new UserError("شرط را بنویسید");
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده");
  const raw = await chat(RULE_PROMPT, [{ role: "user", content: text }], 600);
  const rule = SheetRule.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
  return { rule, ruleText: describeRule(rule) };
}

/** Candidates that match the rule, are not yet in the sheet, as rows in the sheet's column order. */
async function sheetPlan(src: string, jobId?: string) {
  const c = sheetConfig();
  if (!c.url || !c.headers.length) throw new UserError("اتصال گوگل شیت هنوز تنظیم نشده (تنظیمات و اتصال‌ها)");
  if (!Object.values(c.mapping).some(Boolean)) throw new UserError("هیچ ستونی به داده‌ای وصل نشده؛ نگاشت ستون‌ها را تنظیم کنید");
  const all = db().report(src, { jobId });
  // everyone is either added or listed with a reason (only scored people are listed, not pending/errors)
  const skipped: { name: string; reason: string }[] = [];
  const listWorthy = (d: string) => d === "accepted" || d === "partial" || c.rule.decisions.includes(d as any);
  const candidates = all.filter((r) => {
    const ex = parse(r.extra_json) ?? {};
    if (r.gsheet_synced_at) {
      if (listWorthy(r.decision)) skipped.push({ name: r.name, reason: `قبلاً در ${jalaliDate(r.gsheet_synced_at)} به شیت اضافه شده` });
      return false;
    }
    const why = ruleReason(c.rule, {
      decision: r.decision, score: r.score, years: ex.totalWorkExperienceYears ?? null, experienceAlerts: (ex.experienceAlerts ?? []).length,
      city: ex.city ?? null, siteStatus: r.site_status, hasAttachment: !!(ex.personalCvFileId || r.resume_url),
    });
    if (why && listWorthy(r.decision)) skipped.push({ name: r.name, reason: why });
    return !why;
  });
  // people already in the sheet (by the key column)
  let existing = new Map<string, string>(); // key -> who/where
  const keyField = c.keyColumn ? c.mapping[c.keyColumn] : null;
  if (c.keyColumn && keyField) {
    const res = await callSheet<{ values: string[] }>(c.url, { secret: sheetSecret(), action: "keys", sheet: c.sheet, column: c.keyColumn });
    existing = new Map(res.values.map((v) => [normKey(v), "شیت"] as [string, string]).filter(([k]) => !!k));
  }
  const today = jalaliDate(new Date().toISOString());
  const value = (field: string | null, r: (typeof all)[number]) =>
    !field || field === "rowNumber" ? "" : field === "syncedAt" ? today : String(fieldValue(field, r, r.unit ?? "") ?? "");
  const toAdd: typeof all = [];
  const alreadyInSheet: typeof all = [];
  for (const r of candidates) {
    const key = keyField ? normKey(value(keyField, r)) : "";
    const seen = key ? existing.get(key) : undefined;
    if (seen === "شیت") {
      alreadyInSheet.push(r);
      skipped.push({ name: r.name, reason: `از قبل در شیت هست (همان ${c.keyColumn})` });
    } else if (seen) {
      skipped.push({ name: r.name, reason: `تکراری: همان ${c.keyColumn} با «${seen}» (احتمالاً دو بار درخواست داده)` });
    } else {
      toAdd.push(r);
      if (key) existing.set(key, r.name);
    }
  }
  // row numbers continue after the last number found in the sheet's row-number column
  let nextNo = 1;
  const noColumn = c.headers.find((h) => c.mapping[h] === "rowNumber");
  if (noColumn && toAdd.length) {
    const res = await callSheet<{ values: string[] }>(c.url, { secret: sheetSecret(), action: "keys", sheet: c.sheet, column: noColumn });
    const nums = res.values.map((v) => Number(normKey(v).replace(/\D/g, ""))).filter((x) => Number.isFinite(x) && x > 0);
    nextNo = (nums.length ? Math.max(...nums) : res.values.length) + 1;
  }
  const rows = toAdd.map((r, i) => c.headers.map((h) => (c.mapping[h] === "rowNumber" ? String(nextNo + i) : value(c.mapping[h] ?? null, r))));
  return { c, toAdd, alreadyInSheet, rows, skipped };
}

export async function previewSheet(src: string, jobId?: string) {
  try {
    const p = await sheetPlan(src, jobId);
    return { headers: p.c.headers, rows: p.rows.slice(0, 50), count: p.rows.length, alreadyInSheet: p.alreadyInSheet.length, ruleText: describeRule(p.c.rule), skipped: p.skipped };
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
}

export async function syncSheet(src: string, jobId?: string) {
  let p: Awaited<ReturnType<typeof sheetPlan>>;
  try {
    p = await sheetPlan(src, jobId);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  // people found in the sheet already count as synced, so they are not checked again
  db().markSheetSynced(src, p.alreadyInSheet.map((r) => r.id));
  if (!p.rows.length) return { added: 0, alreadyInSheet: p.alreadyInSheet.length };
  for (let i = 0; i < p.rows.length; i += 200) {
    try {
      await callSheet(p.c.url, { secret: sheetSecret(), action: "append", sheet: p.c.sheet, rows: p.rows.slice(i, i + 200) });
    } catch (e) {
      throw new UserError(`افزودن به شیت ناموفق بود: ${e instanceof Error ? e.message : e}`, 502);
    }
    db().markSheetSynced(src, p.toAdd.slice(i, i + 200).map((r) => r.id));
  }
  return { added: p.rows.length, alreadyInSheet: p.alreadyInSheet.length };
}

/** Called after a scoring run when automatic sync is on. Never throws. */
export async function autoSyncSheet(src: string, jobId: string, log: (s: string) => void) {
  const c = sheetConfig();
  if (!c.autoSync || !c.url) return;
  try {
    const r = await syncSheet(src, jobId);
    if (r.added) log(`گوگل شیت: ${r.added} ردیف اضافه شد`);
  } catch (e) {
    log(`✖ گوگل شیت: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------- Jobvision status per result (per job) ----------
/** Jobvision application statuses (BaseData/GetListOfApplicationStatuses). */
export const SITE_STATUSES = { 4: "تایید اولیه", 6: "در حال بررسی", 5: "رد شده" } as const;
type SiteCode = 4 | 5 | 6;
const SITE_STATUS_NAME: Record<SiteCode, string> = { 4: "approved", 6: "checking", 5: "rejected" };
export const SITE_STATUS_FA: Record<string, string> = { approved: "تایید اولیه", checking: "در حال بررسی", rejected: "رد شده" };

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
  return [...groups.entries()].map(([code, rows]) => ({ code, label: SITE_STATUSES[code], count: rows.length, names: rows.slice(0, 10).map((r) => r.name) }));
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
      await s.changeStatus(jobId, batch.map((r) => ({ id: r.id, aiScore: parse(r.extra_json)?.jobvisionMatchScore ?? null })), code);
      db().setSiteStatus(src, batch.map((r) => r.id), SITE_STATUS_NAME[code]);
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
    if (parts.length) log(`جاب‌ویژن: ${parts.join("، ")}`);
  } catch (e) {
    log(`✖ تغییر وضعیت در جاب‌ویژن: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------- "tell it what you want": data tasks (files + Google Sheet) ----------
interface SavedTask {
  id: string;
  title: string;
  instruction: string;
  plan: TaskPlan;
  auto: boolean; // run after each scoring run (Google Sheet tasks)
  lastRunAt?: string;
  lastResult?: string;
}
const TASKS_KEY = "tasks";
const savedTasks = (): SavedTask[] => db().getKv<SavedTask[]>(TASKS_KEY)?.value ?? [];
const storeTasks = (t: SavedTask[]) => db().setKv(TASKS_KEY, t);

/** Tabs and headers of the connected Google Sheet, or null when not connected. */
async function sheetTabs(): Promise<SheetTab[] | null> {
  const c = sheetConfig();
  if (!c.url) return null;
  try {
    return (await callSheet<{ tabs: SheetTab[] }>(c.url, { secret: sheetSecret(), action: "tabs" })).tabs;
  } catch (e) {
    // older script without "tabs": fall back to the one tab it can describe
    if (!/action/.test(String(e))) throw e;
    const info = await callSheet<{ sheet: string; headers: string[]; rows: number }>(c.url, { secret: sheetSecret(), action: "info", sheet: c.sheet });
    return [{ name: info.sheet, headers: info.headers.filter(Boolean), rows: info.rows }];
  }
}

function jobList(src: string) {
  const byJob = new Map<string, { id: string; title: string; count: number }>();
  for (const r of db().report(src, {})) {
    if (!r.job_id) continue;
    const j = byJob.get(r.job_id) ?? { id: r.job_id, title: db().getJobMeta(src, r.job_id).title || r.job || r.job_id, count: 0 };
    j.count++;
    byJob.set(r.job_id, j);
  }
  return [...byJob.values()];
}

/** Turn a plain-language request (optionally a change to an earlier plan) into a plan + description. */
export async function planTask(src: string, instruction: string, previous?: unknown) {
  if (!instruction.trim()) throw new UserError("درخواست را بنویسید");
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده");
  let tabs: SheetTab[] | null = null;
  try {
    tabs = await sheetTabs();
  } catch {
    tabs = null; // sheet unreachable: plan files only
  }
  const jobs = jobList(src);
  const user = previous
    ? `CURRENT PLAN: ${JSON.stringify(previous)}\nCHANGE REQUESTED (keep everything else): ${instruction}`
    : instruction;
  const raw = await chat(planPrompt(jobs, tabs), [{ role: "user", content: user }], 1500);
  let plan: TaskPlan;
  try {
    plan = sanitizePlan(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
  } catch (e) {
    throw new UserError(`هوش مصنوعی برنامهٔ قابل‌فهمی برنگرداند؛ درخواست را واضح‌تر بنویسید. (${e instanceof Error ? e.message.slice(0, 120) : e})`, 502);
  }
  if (plan.destination.type === "gsheet" && !tabs) throw new UserError("گوگل شیت وصل نیست؛ اول در «تنظیمات و اتصال‌ها» وصلش کنید، یا خروجی اکسل/CSV بخواهید.");
  const titles = Object.fromEntries(jobs.map((j) => [j.id, j.title]));
  return { plan, description: describePlan(plan, titles, tabs) };
}

/** The rows a plan produces (and who is left out, and why). */
async function taskRows(src: string, input: unknown) {
  const plan = sanitizePlan(input);
  const f = plan.filter;
  const skipped: { name: string; reason: string }[] = [];
  const since = f.lastDays != null ? Date.now() - f.lastDays * 86_400_000 : null;
  let rows = db()
    .report(src, {})
    .filter((r) => plan.jobs === "all" || plan.jobs.includes(r.job_id ?? ""))
    .filter((r) => {
      const ex = parse(r.extra_json) ?? {};
      let why = ruleReason(f, {
        decision: r.decision, score: r.score, years: ex.totalWorkExperienceYears ?? null, experienceAlerts: (ex.experienceAlerts ?? []).length,
        city: ex.city ?? null, siteStatus: r.site_status, hasAttachment: !!(ex.personalCvFileId || r.resume_url),
      });
      if (!why && since && r.applied_at && new Date(r.applied_at).getTime() < since) why = `قدیمی‌تر از ${f.lastDays} روز`;
      if (why && (r.decision === "accepted" || r.decision === "partial" || f.decisions.includes(r.decision as any))) skipped.push({ name: r.name, reason: why });
      return !why;
    });
  if (plan.sort === "score") rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (plan.sort === "name") rows.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "fa"));
  if (plan.sort === "receivedAt") rows.sort((a, b) => (b.applied_at ?? "").localeCompare(a.applied_at ?? ""));

  const today = jalaliDate(new Date().toISOString());
  const val = (field: string | null, r: (typeof rows)[number]) =>
    !field || field === "rowNumber" ? "" : field === "syncedAt" ? today : String(fieldValue(field, r, r.unit ?? "") ?? "");

  // ---- files
  if (plan.destination.type !== "gsheet") {
    const headers = plan.columns.map((c) => c.label);
    const out = rows.map((r, i) => plan.columns.map((c) => (c.field === "rowNumber" ? String(i + 1) : val(c.field, r))));
    return { plan, headers, rows: out, skipped, newTab: false };
  }

  // ---- Google Sheet: existing tab (its own headers) or a new one (our columns)
  const c = sheetConfig();
  const tabs = (await sheetTabs()) ?? [];
  const tab = tabs.find((t) => t.name === plan.destination.sheet);
  const headers = tab ? tab.headers : plan.columns.map((x) => x.label);
  const fieldOf = (h: string) => (tab ? plan.mapping[h] ?? null : plan.columns.find((x) => x.label === h)?.field ?? null);
  if (tab && !headers.some((h) => fieldOf(h))) throw new UserError(`هیچ ستونی از برگهٔ «${tab.name}» به داده‌ای وصل نشده؛ درخواست را دقیق‌تر بنویسید.`);
  // people already in the tab (key column), and duplicates inside this batch
  const keyHeader = plan.keyColumn && headers.includes(plan.keyColumn) ? plan.keyColumn : headers.find((h) => fieldOf(h) === "phone") ?? null;
  const seen = new Map<string, string>();
  let lastNo = 0;
  if (tab && tab.rows > 0) {
    if (keyHeader) {
      const res = await callSheet<{ values: string[] }>(c.url, { secret: sheetSecret(), action: "keys", sheet: tab.name, column: keyHeader });
      for (const v of res.values) if (normKey(v)) seen.set(normKey(v), "شیت");
    }
    const noHeader = headers.find((h) => fieldOf(h) === "rowNumber");
    if (noHeader) {
      const res = await callSheet<{ values: string[] }>(c.url, { secret: sheetSecret(), action: "keys", sheet: tab.name, column: noHeader });
      const nums = res.values.map((v) => Number(normKey(v).replace(/\D/g, ""))).filter((x) => x > 0);
      lastNo = nums.length ? Math.max(...nums) : res.values.length;
    }
  }
  const keyField = keyHeader ? fieldOf(keyHeader) : null;
  rows = rows.filter((r) => {
    const k = keyField ? normKey(val(keyField, r)) : "";
    const prev = k ? seen.get(k) : undefined;
    if (prev === "شیت") skipped.push({ name: r.name, reason: `از قبل در برگه هست (همان ${keyHeader})` });
    else if (prev) skipped.push({ name: r.name, reason: `تکراری: همان ${keyHeader} با «${prev}»` });
    if (prev) return false;
    if (k) seen.set(k, r.name);
    return true;
  });
  const out = rows.map((r, i) => headers.map((h) => (fieldOf(h) === "rowNumber" ? String(lastNo + i + 1) : val(fieldOf(h), r))));
  return { plan, headers, rows: out, skipped, newTab: !tab };
}

export async function previewTask(src: string, plan: unknown) {
  try {
    const t = await taskRows(src, plan);
    return { headers: t.headers, rows: t.rows.slice(0, 30), count: t.rows.length, skipped: t.skipped, newTab: t.newTab };
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
}

/** Run a plan: a file to download, or rows appended to the Google Sheet. */
export async function runTask(src: string, plan: unknown): Promise<{ added?: number; file?: { token: string; name: string }; skipped: number; message: string }> {
  let t: Awaited<ReturnType<typeof taskRows>>;
  try {
    t = await taskRows(src, plan);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  const d = t.plan.destination;
  if (d.type !== "gsheet") {
    const ext = d.type === "csv" ? "csv" : "xlsx";
    const data = d.type === "csv" ? buildCsv(t.headers, t.rows) : buildXlsx(t.plan.title, t.headers, t.rows);
    const token = randomUUID();
    const dir = path.join(dataDir(), "exports");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${token}.${ext}`), data);
    const name = `${safeName(t.plan.title)} - ${jalaliDate(new Date().toISOString()).replace(/\//g, "-")}.${ext}`;
    return { file: { token, name }, skipped: t.skipped.length, message: `${t.rows.length} ردیف در فایل` };
  }
  if (!t.rows.length) return { added: 0, skipped: t.skipped.length, message: "ردیف جدیدی برای افزودن نبود" };
  const c = sheetConfig();
  for (let i = 0; i < t.rows.length; i += 200) {
    try {
      await callSheet(c.url, { secret: sheetSecret(), action: "append", sheet: d.sheet, create: t.newTab, headers: t.headers, rows: t.rows.slice(i, i + 200) });
    } catch (e) {
      throw new UserError(`نوشتن در گوگل شیت ناموفق بود: ${e instanceof Error ? e.message : e}`, 502);
    }
  }
  return { added: t.rows.length, skipped: t.skipped.length, message: `${t.rows.length} ردیف به برگهٔ «${d.sheet}» اضافه شد` };
}

/** Download a file made by runTask. */
export async function taskFile(token: string, name: string) {
  const ext = name.endsWith(".csv") ? "csv" : "xlsx";
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new UserError("not found", 404);
  const data = await fsp.readFile(path.join(dataDir(), "exports", `${token}.${ext}`)).catch(() => {
    throw new UserError("فایل پیدا نشد یا منقضی شده", 404);
  });
  return { data, type: ext === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

// ---- saved tasks ("قانون‌ها")
export function listSavedTasks(src: string) {
  const titles = Object.fromEntries(jobList(src).map((j) => [j.id, j.title]));
  return savedTasks().map((t) => ({ ...t, description: describePlan(t.plan, titles, null) }));
}
export function saveTask(input: { id?: string; title?: string; instruction?: string; plan: unknown; auto?: boolean }) {
  const plan = sanitizePlan(input.plan);
  const all = savedTasks();
  const existing = input.id ? all.find((t) => t.id === input.id) : undefined;
  const t: SavedTask = {
    id: existing?.id ?? randomUUID(),
    title: input.title?.trim() || plan.title,
    instruction: input.instruction ?? existing?.instruction ?? "",
    plan,
    auto: (input.auto ?? existing?.auto ?? false) && plan.destination.type === "gsheet",
    lastRunAt: existing?.lastRunAt,
    lastResult: existing?.lastResult,
  };
  storeTasks(existing ? all.map((x) => (x.id === t.id ? t : x)) : [...all, t]);
  return t;
}
export function deleteTask(id: string) {
  storeTasks(savedTasks().filter((t) => t.id !== id));
  return { ok: true };
}
export async function runSavedTask(src: string, id: string) {
  const t = savedTasks().find((x) => x.id === id);
  if (!t) throw new UserError("قانون پیدا نشد", 404);
  const r = await runTask(src, t.plan);
  storeTasks(savedTasks().map((x) => (x.id === id ? { ...x, lastRunAt: new Date().toISOString(), lastResult: r.message } : x)));
  return r;
}

/** After a scoring run: saved Google Sheet rules marked "auto" that include this job. Never throws. */
export async function autoRunTasks(src: string, jobId: string, log: (s: string) => void) {
  for (const t of savedTasks().filter((x) => x.auto && (x.plan.jobs === "all" || x.plan.jobs.includes(jobId)))) {
    try {
      const r = await runSavedTask(src, t.id);
      if (r.added) log(`«${t.title}»: ${r.message}`);
    } catch (e) {
      log(`✖ «${t.title}»: ${e instanceof Error ? e.message : e}`);
    }
  }
}
