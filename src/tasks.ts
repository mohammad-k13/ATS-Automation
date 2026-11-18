/**
 * "Tell it what you want" data tasks: the employer writes a request in plain Persian, the AI turns it
 * into a TaskPlan (which jobs, which people, which columns, where to), the employer checks the plan and a
 * preview, and the server builds the rows from the database and writes the file / Google Sheet tab.
 * The AI only plans; it never writes cell values. Pure helpers here; the database part is in service.ts.
 */
import { z } from "zod";
import { SHEET_FIELDS, SheetRule } from "./gsheet";

export const TaskPlan = z.object({
  title: z.string().trim().min(1).max(100).default("خروجی"),
  /** job ids, or "all" */
  jobs: z.union([z.literal("all"), z.array(z.coerce.string()).min(1)]).default("all"),
  filter: SheetRule.extend({
    /** only people who applied in the last N days */
    lastDays: z.number().int().min(1).max(3650).nullable().default(null),
  }).prefault({}),
  destination: z
    .object({
      type: z.enum(["xlsx", "csv", "gsheet"]),
      /** Google Sheet tab name (existing, or a new one to create) */
      sheet: z.string().trim().max(100).optional(),
    })
    .default({ type: "xlsx" }),
  /** for files and new sheet tabs: column order and titles */
  columns: z.array(z.object({ field: z.string(), label: z.string().trim().min(1).max(60) })).default([]),
  /** for an existing sheet tab: its header -> one of our fields (null = leave empty) */
  mapping: z.record(z.string(), z.string().nullable()).default({}),
  /** header (gsheet) whose value identifies a person already in the tab; usually the phone column */
  keyColumn: z.string().nullable().default(null),
  sort: z.enum(["score", "name", "receivedAt"]).nullable().default("score"),
});
export type TaskPlan = z.infer<typeof TaskPlan>;

export interface SheetTab {
  name: string;
  headers: string[];
  rows: number;
}

/** The planning prompt, with what the AI needs to know about the jobs and the sheet. */
export function planPrompt(jobs: { id: string; title: string; count: number }[], tabs: SheetTab[] | null): string {
  return `You plan data exports for an Iranian employer's ATS. The employer writes a request in Persian; reply with ONE JSON object (no prose):
{"title": short Persian title,
 "jobs": "all" or [job ids from the list below],
 "filter": {"decisions": subset of ["accepted","partial","rejected","pending"] (قبول/تایید نسبی/رد/بررسی‌نشده; default ["accepted","partial"]),
            "minScore": n|null, "maxScore": n|null, "minYears": n|null, "maxExperienceAlerts": n|null (0 = clean work history),
            "cities": [], "excludeRejectedOnSite": true, "onlyWithAttachment": false, "lastDays": n|null},
 "destination": {"type": "xlsx" | "csv" | "gsheet", "sheet": "tab name (gsheet only)"},
 "columns": [{"field": field key, "label": Persian column title}]   // for xlsx/csv, and for a NEW sheet tab
 "mapping": {"<existing tab header>": field key | null}              // only for an EXISTING sheet tab: cover EVERY header
 "keyColumn": header used to skip people already in the tab (usually the phone column) | null,
 "sort": "score" | "name" | "receivedAt"}
Field keys: ${Object.entries(SHEET_FIELDS).map(([k, v]) => `${k} (${v})`).join(", ")}.
Rules: Excel unless they ask for CSV or the sheet. If they name a sheet tab that exists, use "mapping" with its exact headers;
if they name a tab that does not exist, use "columns" (it will be created). Only set filters the employer asked for.
Jobs (id: title, applicants): ${jobs.map((j) => `${j.id}: ${j.title} (${j.count})`).join(" | ") || "none"}
${tabs ? `Google Sheet tabs: ${tabs.map((t) => `"${t.name}" [${t.headers.join(", ")}] (${t.rows} rows)`).join(" | ")}` : "Google Sheet: not connected (do not use gsheet)."}`;
}

const FA_DEC: Record<string, string> = { accepted: "قبول", partial: "تایید نسبی", rejected: "رد", pending: "بررسی‌نشده" };
const n = (x: number) => x.toLocaleString("fa-IR", { useGrouping: false });

/** Plain Persian description of a plan, for the employer to check before running it. */
export function describePlan(p: TaskPlan, jobTitles: Record<string, string>, tabs: SheetTab[] | null): string[] {
  const f = p.filter;
  const out: string[] = [];
  out.push(`آگهی‌ها: ${p.jobs === "all" ? "همه" : p.jobs.map((id) => `«${jobTitles[id] ?? id}»`).join("، ")}`);
  const who = [`وضعیت ${f.decisions.length ? f.decisions.map((d) => FA_DEC[d]).join("، ") : "همه"}`];
  if (f.minScore != null) who.push(`امتیاز حداقل ${n(f.minScore)}`);
  if (f.maxScore != null) who.push(`امتیاز حداکثر ${n(f.maxScore)}`);
  if (f.minYears != null) who.push(`سابقه حداقل ${n(f.minYears)} سال`);
  if (f.maxExperienceAlerts === 0) who.push("بدون هشدار سوابق کاری");
  else if (f.maxExperienceAlerts != null) who.push(`حداکثر ${n(f.maxExperienceAlerts)} هشدار سوابق`);
  if (f.cities.length) who.push(`شهر ${f.cities.join("، ")}`);
  if (f.lastDays != null) who.push(`ارسال‌شده در ${n(f.lastDays)} روز اخیر`);
  if (f.onlyWithAttachment) who.push("دارای فایل پیوست");
  if (f.excludeRejectedOnSite) who.push("به‌جز ردشده‌ها در جاب‌ویژن");
  out.push(`چه کسانی: ${who.join("، ")}`);
  const d = p.destination;
  if (d.type === "gsheet") {
    const exists = tabs?.some((t) => t.name === d.sheet);
    out.push(`مقصد: گوگل شیت، برگهٔ «${d.sheet ?? "اول"}»${exists ? "" : " (برگهٔ جدید ساخته می‌شود)"}`);
    if (p.keyColumn) out.push(`تکراری‌ها با ستون «${p.keyColumn}» شناخته و اضافه نمی‌شوند`);
  } else out.push(`مقصد: فایل ${d.type === "csv" ? "CSV" : "اکسل"} برای دانلود`);
  const cols = d.type === "gsheet" && Object.keys(p.mapping).length
    ? Object.entries(p.mapping).map(([h, f]) => `${h} ← ${f ? SHEET_FIELDS[f] ?? f : "خالی"}`)
    : p.columns.map((c) => c.label);
  out.push(`ستون‌ها: ${cols.join("، ")}`);
  if (p.sort) out.push(`ترتیب: ${{ score: "امتیاز (بیشترین اول)", name: "نام", receivedAt: "تاریخ ارسال (جدیدترین اول)" }[p.sort]}`);
  return out;
}

/** Keep only known fields; give files sensible default columns. */
export function sanitizePlan(raw: unknown): TaskPlan {
  const p = TaskPlan.parse(raw);
  p.columns = p.columns.filter((c) => c.field in SHEET_FIELDS);
  p.mapping = Object.fromEntries(Object.entries(p.mapping).map(([h, f]) => [h, f && f in SHEET_FIELDS ? f : null]));
  if (!p.columns.length && !(p.destination.type === "gsheet" && Object.keys(p.mapping).length))
    p.columns = ["name", "phone", "jobTitle", "status", "score", "receivedAt"].map((f) => ({ field: f, label: SHEET_FIELDS[f] }));
  if (p.destination.type === "gsheet" && !p.destination.sheet) p.destination.sheet = p.title;
  return p;
}

/** CSV that Excel opens correctly with Persian text (UTF-8 BOM, CRLF, quoted). */
export function buildCsv(columns: string[], rows: (string | number)[][]): Uint8Array {
  const q = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [columns, ...rows].map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
  return new TextEncoder().encode(text);
}
