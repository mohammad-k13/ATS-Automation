/** "Tell it what you want": ad-hoc and saved AI-planned data exports (files or Google Sheet rows). */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getChat } from '../infra/ai';
import { jalaliDate, fieldValue } from '../infra/exports';
import { buildXlsx } from '../infra/xlsx';
import { callSheet, normKey, ruleReason } from '../infra/gsheet';
import {
  buildCsv,
  describePlan,
  planPrompt,
  sanitizePlan,
  type SheetTab,
  type TaskPlan,
} from '../../platform/tasks';
import { sheetConfig, sheetSecret } from './sheet-sync';
import { dataDir, db, parse, safeName, UserError } from './state';

interface SavedTask {
  id: string;
  title: string;
  instruction: string;
  plan: TaskPlan;
  auto: boolean; // run after each scoring run (Google Sheet tasks)
  lastRunAt?: string;
  lastResult?: string;
}
const TASKS_KEY = 'tasks';
const savedTasks = (): SavedTask[] => db().getKv<SavedTask[]>(TASKS_KEY)?.value ?? [];
const storeTasks = (t: SavedTask[]) => db().setKv(TASKS_KEY, t);

/** Tabs and headers of the connected Google Sheet, or null when not connected. */
async function sheetTabs(): Promise<SheetTab[] | null> {
  const c = sheetConfig();
  if (!c.url) return null;
  try {
    return (await callSheet<{ tabs: SheetTab[] }>(c.url, { secret: sheetSecret(), action: 'tabs' }))
      .tabs;
  } catch (e) {
    // older script without "tabs": fall back to the one tab it can describe
    if (!/action/.test(String(e))) throw e;
    const info = await callSheet<{ sheet: string; headers: string[]; rows: number }>(c.url, {
      secret: sheetSecret(),
      action: 'info',
      sheet: c.sheet,
    });
    return [{ name: info.sheet, headers: info.headers.filter(Boolean), rows: info.rows }];
  }
}

function jobList(src: string) {
  const byJob = new Map<string, { id: string; title: string; count: number }>();
  for (const r of db().report(src, {})) {
    if (!r.job_id) continue;
    const j = byJob.get(r.job_id) ?? {
      id: r.job_id,
      title: db().getJobMeta(src, r.job_id).title || r.job || r.job_id,
      count: 0,
    };
    j.count++;
    byJob.set(r.job_id, j);
  }
  return [...byJob.values()];
}

/** Turn a plain-language request (optionally a change to an earlier plan) into a plan + description. */
export async function planTask(src: string, instruction: string, previous?: unknown) {
  if (!instruction.trim()) throw new UserError('درخواست را بنویسید');
  const chat = getChat();
  if (!chat) throw new UserError('هوش مصنوعی تنظیم نشده');
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
  const raw = await chat(planPrompt(jobs, tabs), [{ role: 'user', content: user }], 1500);
  let plan: TaskPlan;
  try {
    plan = sanitizePlan(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)));
  } catch (e) {
    throw new UserError(
      `هوش مصنوعی برنامهٔ قابل‌فهمی برنگرداند؛ درخواست را واضح‌تر بنویسید. (${e instanceof Error ? e.message.slice(0, 120) : e})`,
      502,
    );
  }
  if (plan.destination.type === 'gsheet' && !tabs)
    throw new UserError(
      'گوگل شیت وصل نیست؛ اول در «تنظیمات و اتصال‌ها» وصلش کنید، یا خروجی اکسل/CSV بخواهید.',
    );
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
    .filter((r) => plan.jobs === 'all' || plan.jobs.includes(r.job_id ?? ''))
    .filter((r) => {
      const ex = parse(r.extra_json) ?? {};
      let why = ruleReason(f, {
        decision: r.decision,
        score: r.score,
        years: ex.totalWorkExperienceYears ?? null,
        experienceAlerts: (ex.experienceAlerts ?? []).length,
        city: ex.city ?? null,
        siteStatus: r.site_status,
        hasAttachment: !!(ex.personalCvFileId || r.resume_url),
      });
      if (!why && since && r.applied_at && new Date(r.applied_at).getTime() < since)
        why = `قدیمی‌تر از ${f.lastDays} روز`;
      if (
        why &&
        (r.decision === 'accepted' ||
          r.decision === 'partial' ||
          f.decisions.includes(r.decision as any))
      )
        skipped.push({ name: r.name, reason: why });
      return !why;
    });
  if (plan.sort === 'score') rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (plan.sort === 'name') rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'fa'));
  if (plan.sort === 'receivedAt')
    rows.sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? ''));

  const today = jalaliDate(new Date().toISOString());
  const val = (field: string | null, r: (typeof rows)[number]) =>
    !field || field === 'rowNumber'
      ? ''
      : field === 'syncedAt'
        ? today
        : String(fieldValue(field, r, r.unit ?? '') ?? '');

  // ---- files
  if (plan.destination.type !== 'gsheet') {
    const headers = plan.columns.map((c) => c.label);
    const out = rows.map((r, i) =>
      plan.columns.map((c) => (c.field === 'rowNumber' ? String(i + 1) : val(c.field, r))),
    );
    return { plan, headers, rows: out, skipped, newTab: false };
  }

  // ---- Google Sheet: existing tab (its own headers) or a new one (our columns)
  const c = sheetConfig();
  const tabs = (await sheetTabs()) ?? [];
  const tab = tabs.find((t) => t.name === plan.destination.sheet);
  const headers = tab ? tab.headers : plan.columns.map((x) => x.label);
  const fieldOf = (h: string) =>
    tab ? (plan.mapping[h] ?? null) : (plan.columns.find((x) => x.label === h)?.field ?? null);
  if (tab && !headers.some((h) => fieldOf(h)))
    throw new UserError(
      `هیچ ستونی از برگهٔ «${tab.name}» به داده‌ای وصل نشده؛ درخواست را دقیق‌تر بنویسید.`,
    );
  // people already in the tab (key column), and duplicates inside this batch
  const keyHeader =
    plan.keyColumn && headers.includes(plan.keyColumn)
      ? plan.keyColumn
      : (headers.find((h) => fieldOf(h) === 'phone') ?? null);
  const seen = new Map<string, string>();
  let lastNo = 0;
  if (tab && tab.rows > 0) {
    if (keyHeader) {
      const res = await callSheet<{ values: string[] }>(c.url, {
        secret: sheetSecret(),
        action: 'keys',
        sheet: tab.name,
        column: keyHeader,
      });
      for (const v of res.values) if (normKey(v)) seen.set(normKey(v), 'شیت');
    }
    const noHeader = headers.find((h) => fieldOf(h) === 'rowNumber');
    if (noHeader) {
      const res = await callSheet<{ values: string[] }>(c.url, {
        secret: sheetSecret(),
        action: 'keys',
        sheet: tab.name,
        column: noHeader,
      });
      const nums = res.values
        .map((v) => Number(normKey(v).replace(/\D/g, '')))
        .filter((x) => x > 0);
      lastNo = nums.length ? Math.max(...nums) : res.values.length;
    }
  }
  const keyField = keyHeader ? fieldOf(keyHeader) : null;
  rows = rows.filter((r) => {
    const k = keyField ? normKey(val(keyField, r)) : '';
    const prev = k ? seen.get(k) : undefined;
    if (prev === 'شیت')
      skipped.push({ name: r.name, reason: `از قبل در برگه هست (همان ${keyHeader})` });
    else if (prev) skipped.push({ name: r.name, reason: `تکراری: همان ${keyHeader} با «${prev}»` });
    if (prev) return false;
    if (k) seen.set(k, r.name);
    return true;
  });
  const out = rows.map((r, i) =>
    headers.map((h) => (fieldOf(h) === 'rowNumber' ? String(lastNo + i + 1) : val(fieldOf(h), r))),
  );
  return { plan, headers, rows: out, skipped, newTab: !tab };
}

export async function previewTask(src: string, plan: unknown) {
  try {
    const t = await taskRows(src, plan);
    return {
      headers: t.headers,
      rows: t.rows.slice(0, 30),
      count: t.rows.length,
      skipped: t.skipped,
      newTab: t.newTab,
    };
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
}

/** Run a plan: a file to download, or rows appended to the Google Sheet. */
export async function runTask(
  src: string,
  plan: unknown,
): Promise<{
  added?: number;
  file?: { token: string; name: string };
  skipped: number;
  message: string;
}> {
  let t: Awaited<ReturnType<typeof taskRows>>;
  try {
    t = await taskRows(src, plan);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  const d = t.plan.destination;
  if (d.type !== 'gsheet') {
    const ext = d.type === 'csv' ? 'csv' : 'xlsx';
    const data =
      d.type === 'csv' ? buildCsv(t.headers, t.rows) : buildXlsx(t.plan.title, t.headers, t.rows);
    const token = randomUUID();
    const dir = path.join(dataDir(), 'exports');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${token}.${ext}`), data);
    const name = `${safeName(t.plan.title)} - ${jalaliDate(new Date().toISOString()).replace(/\//g, '-')}.${ext}`;
    return {
      file: { token, name },
      skipped: t.skipped.length,
      message: `${t.rows.length} ردیف در فایل`,
    };
  }
  if (!t.rows.length)
    return { added: 0, skipped: t.skipped.length, message: 'ردیف جدیدی برای افزودن نبود' };
  const c = sheetConfig();
  for (let i = 0; i < t.rows.length; i += 200) {
    try {
      await callSheet(c.url, {
        secret: sheetSecret(),
        action: 'append',
        sheet: d.sheet,
        create: t.newTab,
        headers: t.headers,
        rows: t.rows.slice(i, i + 200),
      });
    } catch (e) {
      throw new UserError(
        `نوشتن در گوگل شیت ناموفق بود: ${e instanceof Error ? e.message : e}`,
        502,
      );
    }
  }
  return {
    added: t.rows.length,
    skipped: t.skipped.length,
    message: `${t.rows.length} ردیف به برگهٔ «${d.sheet}» اضافه شد`,
  };
}

/** Download a file made by runTask. */
export async function taskFile(token: string, name: string) {
  const ext = name.endsWith('.csv') ? 'csv' : 'xlsx';
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new UserError('not found', 404);
  const data = await fsp.readFile(path.join(dataDir(), 'exports', `${token}.${ext}`)).catch(() => {
    throw new UserError('فایل پیدا نشد یا منقضی شده', 404);
  });
  return {
    data,
    type:
      ext === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

// ---- saved tasks ("قانون‌ها")
export function listSavedTasks(src: string) {
  const titles = Object.fromEntries(jobList(src).map((j) => [j.id, j.title]));
  return savedTasks().map((t) => ({ ...t, description: describePlan(t.plan, titles, null) }));
}
export function saveTask(input: {
  id?: string;
  title?: string;
  instruction?: string;
  plan: unknown;
  auto?: boolean;
}) {
  const plan = sanitizePlan(input.plan);
  const all = savedTasks();
  const existing = input.id ? all.find((t) => t.id === input.id) : undefined;
  const t: SavedTask = {
    id: existing?.id ?? randomUUID(),
    title: input.title?.trim() || plan.title,
    instruction: input.instruction ?? existing?.instruction ?? '',
    plan,
    auto: (input.auto ?? existing?.auto ?? false) && plan.destination.type === 'gsheet',
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
  if (!t) throw new UserError('قانون پیدا نشد', 404);
  const r = await runTask(src, t.plan);
  storeTasks(
    savedTasks().map((x) =>
      x.id === id ? { ...x, lastRunAt: new Date().toISOString(), lastResult: r.message } : x,
    ),
  );
  return r;
}

/** After a scoring run: saved Google Sheet rules marked "auto" that include this job. Never throws. */
export async function autoRunTasks(src: string, jobId: string, log: (s: string) => void) {
  for (const t of savedTasks().filter(
    (x) => x.auto && (x.plan.jobs === 'all' || x.plan.jobs.includes(jobId)),
  )) {
    try {
      const r = await runSavedTask(src, t.id);
      if (r.added) log(`«${t.title}»: ${r.message}`);
    } catch (e) {
      log(`✖ «${t.title}»: ${e instanceof Error ? e.message : e}`);
    }
  }
}
