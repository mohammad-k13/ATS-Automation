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
import { JobvisionSource, jwtExpiry } from "./sources/jobvision-source";
import type { Application, Criteria, Source } from "./types";

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

// ---------- .env ----------
function writeEnv(key: string, value: string) {
  const file = ".env";
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join("\n"));
  env[key] = value;
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
const tokenKey = (src: string) => `${src.toUpperCase()}_TOKEN`;

export function tokenInfo(src: string) {
  const raw = (env[tokenKey(src)] ?? "").replace(/^Bearer\s+/i, "").trim();
  const exp = raw ? jwtExpiry(raw) : null;
  return { hasToken: !!raw, expiresAt: exp?.toISOString() ?? null, valid: !!exp && exp.getTime() > Date.now() + 60_000 };
}

export function status() {
  let platforms: { name: string; type: string; token: ReturnType<typeof tokenInfo> }[] = [];
  let sourcesError: string | null = null;
  try {
    platforms = sources().map((s) => ({ name: s.name, type: s instanceof JobvisionSource ? "jobvision" : "other", token: tokenInfo(s.name) }));
  } catch (e) {
    sourcesError = e instanceof Error ? e.message : String(e);
  }
  return { ai: aiInfo(), telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), platforms, sourcesError };
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

export function getJobSettings(src: string, jobId: string) {
  const { criteria, kind } = criteriaFor(src, jobId);
  const cfg = rawSourceConfig(src);
  return {
    criteria: criteria
      ? { threshold: criteria.threshold, mustHave: criteria.mustHave, niceToHave: criteria.niceToHave, hardFilters: { minYears: criteria.hardFilters.minYears ?? null, requireAny: criteria.hardFilters.requireAny ?? [], rejectIfAny: criteria.hardFilters.rejectIfAny ?? [] }, instructions: criteria.instructions ?? "" }
      : null,
    criteriaKind: kind,
    criteriaName: criteria?.name ?? null,
    scheduled: (cfg.jobPostIds ?? []).map(String).includes(String(jobId)),
    sourceStatus: cfg.status ?? 10,
  };
}

export function saveJobCriteria(src: string, jobId: string, input: unknown, jobTitle?: string) {
  const c = CriteriaInput.parse(input);
  const doc = {
    name: `job-${jobId}`,
    match: { jobIds: [String(jobId)] },
    threshold: c.threshold,
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
export async function draftCriteria(jobTitle: string, description: string, current: CriteriaInput | null) {
  const chat = getChat();
  if (!chat) throw new UserError("هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)");
  const system = `You turn an employer's plain description of a job into screening rules for an ATS in Iran.
Reply with ONE JSON object only:
{"threshold": number 0-100 (default 70; stricter if the employer sounds strict),
 "mustHave": [short skill/experience phrases that are truly required, in the language candidates use in resumes - usually Persian, keep tool names in English],
 "niceToHave": [bonus phrases],
 "hardFilters": {"minYears": number|null, "requireAny": [], "rejectIfAny": []},
 "instructions": "clear Persian brief for the AI screener: what kind of person, priorities, what to penalize"}
Never add rules about gender, age, religion, ethnicity or marital status even if asked; mention this in instructions instead of encoding it.
Keep mustHave to the 3-6 most important items. Use hardFilters only for things the employer says are absolute.`;
  const user = `JOB TITLE: ${jobTitle}\n${current ? `CURRENT RULES (update them, keep what the employer did not change): ${JSON.stringify(current)}\n` : ""}EMPLOYER SAYS:\n${description}`;
  const raw = await chat(system, [{ role: "user", content: user }], 1500);
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return CriteriaInput.parse(JSON.parse(json));
}

// ---------- jobs & applications ----------
export async function listJobs(src: string) {
  const s = jobvision(src);
  const jobs = await s.listJobs();
  const stats = new Map(db().jobStats(src).map((x) => [x.job_id, x]));
  const scheduled = new Set((rawSourceConfig(src).jobPostIds ?? []).map(String));
  return jobs.map((j) => {
    const st = stats.get(j.id);
    return {
      ...j,
      criteriaKind: criteriaFor(src, j.id, j.title).kind,
      scheduled: scheduled.has(j.id),
      stats: st ? { total: st.total, accepted: st.accepted, rejected: st.rejected, errors: st.errors, pending: st.pending, avgScore: st.avg_score, lastProcessed: st.last_processed } : null,
      task: state().tasks.get(`${src}:${j.id}`) ?? null,
    };
  });
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
}

export function getTask(src: string, jobId: string): Task | null {
  return state().tasks.get(`${src}:${jobId}`) ?? null;
}

/** Score some (ids) or all applicants of a job in the background. */
export function startScoring(src: string, jobId: string, opts: { ids?: string[]; rescore?: boolean }) {
  const key = `${src}:${jobId}`;
  if (state().tasks.get(key)?.running) throw new UserError("امتیازدهی این آگهی در حال اجراست", 409);
  const s = source(src);
  const rows = db().listByJob(src, jobId);
  const targets = rows.filter((r) => (opts.ids ? opts.ids.includes(r.id) : true)).filter((r) => opts.rescore || r.decision === "pending" || r.decision === "error");
  const { criteria } = criteriaFor(src, jobId, rows[0]?.job ?? undefined);
  if (!criteria) throw new UserError("اول در بخش تنظیمات، شرایط این آگهی را تعریف کنید.");
  if (!targets.length) throw new UserError(opts.ids ? "رزومه‌های انتخاب‌شده قبلاً امتیاز گرفته‌اند. برای امتیازدهی دوباره «امتیاز مجدد» را بزنید." : "رزومهٔ جدیدی برای امتیازدهی نیست.");

  const task: Task = { running: true, done: 0, total: targets.length, current: null, log: [], errors: 0, startedAt: new Date().toISOString() };
  state().tasks.set(key, task);
  const scorer = getScorer();
  const log = (l: string) => {
    task.log.push(l);
    if (task.log.length > 200) task.log.shift();
  };

  (async () => {
    for (const r of targets) {
      task.current = r.name;
      const app: Application = {
        source: src, id: r.id, name: r.name, jobId: r.job_id ?? jobId, jobTitle: r.job ?? undefined,
        profileUrl: r.profile_url ?? undefined, resumeUrl: r.resume_url ?? undefined, appliedAt: r.applied_at ?? undefined, extra: parse(r.extra_json) ?? undefined,
      };
      try {
        const text = s.getResumeText ? await s.getResumeText(app) : "";
        if (text.length < 50) throw new Error("متن رزومه خالی است");
        const res = await scorer.score(app, text, criteria);
        db().save({ source: src, id: app.id, name: app.name, job: app.jobTitle, jobId: app.jobId, decision: res.pass ? "accepted" : "rejected", score: res.score, result: res, resumeText: text, extra: app.extra, profileUrl: app.profileUrl, resumeUrl: app.resumeUrl, appliedAt: app.appliedAt });
        log(`${app.name}: ${res.score}`);
      } catch (e) {
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
  const base = `- ${r.name} | وضعیت: ${r.decision}${r.score != null ? ` | امتیاز: ${r.score}` : ""} | سابقه: ${ex.totalWorkExperienceYears ?? "?"} سال | آخرین شغل: ${ex.lastJob ?? "-"} | شهر: ${ex.city ?? "-"} | حقوق درخواستی: ${ex.requestedSalary ?? "-"}`;
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
  const rows = db().listByJob(src, jobId);
  const title = rows[0]?.job ?? `آگهی ${jobId}`;
  const { criteria } = criteriaFor(src, jobId, title);

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

  const system = `تو دستیار استخدام یک کارفرما هستی و دربارهٔ یک آگهی شغلی و رزومه‌های دریافتی آن با او گفتگو می‌کنی.
همیشه به فارسی، کوتاه، دقیق و کاربردی جواب بده. فقط بر اساس اطلاعات زیر حرف بزن و اگر اطلاعاتی نیست صادقانه بگو.
وقتی می‌پرسد چرا کسی پذیرفته یا رد شده، به نقاط قوت/ضعف و شرایط آگهی استناد کن. وقتی مقایسه می‌خواهد، جدول یا فهرست کوتاه بده.
جنسیت، سن، مذهب، قومیت و وضعیت تأهل را در قضاوت دخالت نده.

## آگهی: ${title}
${criteria ? `حداقل امتیاز قبولی: ${criteria.threshold}
الزامی: ${criteria.mustHave.join("، ") || "-"}
امتیاز اضافه: ${criteria.niceToHave.join("، ") || "-"}
${criteria.hardFilters.minYears != null ? `حداقل سابقه: ${criteria.hardFilters.minYears} سال\n` : ""}توضیحات کارفرما: ${criteria.instructions ?? "-"}` : "شرایط آگهی هنوز تعریف نشده."}

## رزومه‌ها (${rows.length} نفر)
${rows.slice(0, 150).map(candidateLine).join("\n")}

${resumes.length ? `## جزئیات\n${resumes.join("\n\n")}` : ""}`;

  const history = db().getChat(src, jobId);
  const messages: ChatMessage[] = [...history.slice(-20), { role: "user", content: message }];
  const answer = await chat(system, messages, 2500);
  const saved = [...history, { role: "user" as const, content: message }, { role: "assistant" as const, content: answer }];
  db().saveChat(src, jobId, saved);
  return { answer, messages: saved };
}
