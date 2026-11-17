/**
 * Google Sheet sync through a small Apps Script web app that the user pastes into their sheet.
 * No Google Cloud project or service account needed. Everything here is pure (no DB) and testable.
 */
import { z } from "zod";
import { httpFetch } from "./http";

// ------------------------------------------------------------------ Apps Script the user pastes
export function appsScript(secret: string): string {
  return `// سامانهٔ جذب — اتصال به گوگل شیت
// این کد را در Extensions → Apps Script بچسبانید، ذخیره کنید و Deploy → New deployment → Web app بزنید.
const SECRET = "${secret}";

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.secret !== SECRET) return out({ ok: false, error: "secret اشتباه است" });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = req.sheet ? ss.getSheetByName(req.sheet) : ss.getSheets()[0];
    if (!sh) return out({ ok: false, error: "برگه پیدا نشد: " + req.sheet });
    const lastCol = Math.max(sh.getLastColumn(), 1);
    const lastRow = sh.getLastRow();
    const headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];

    if (req.action === "info") {
      return out({ ok: true, sheets: ss.getSheets().map((s) => s.getName()), sheet: sh.getName(), headers, rows: Math.max(lastRow - 1, 0), title: ss.getName() });
    }
    if (req.action === "keys") {
      const col = headers.indexOf(req.column) + 1;
      if (!col) return out({ ok: false, error: "ستون پیدا نشد: " + req.column });
      const values = lastRow > 1 ? sh.getRange(2, col, lastRow - 1, 1).getDisplayValues().map((r) => r[0]) : [];
      return out({ ok: true, values });
    }
    if (req.action === "append") {
      const rows = req.rows || [];
      if (!rows.length) return out({ ok: true, added: 0 });
      const lock = LockService.getDocumentLock();
      lock.waitLock(30000);
      try {
        const start = sh.getLastRow() + 1;
        const range = sh.getRange(start, 1, rows.length, rows[0].length);
        range.setNumberFormat("@"); // keep phone numbers and dates as text (no lost leading zero)
        range.setValues(rows);
      } finally {
        lock.releaseLock();
      }
      return out({ ok: true, added: rows.length });
    }
    return out({ ok: false, error: "action نامعتبر" });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}
`;
}

// ------------------------------------------------------------------ calling the web app
export async function callSheet<T = any>(url: string, payload: Record<string, unknown>, proxy?: string): Promise<T> {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/.test(url) && !process.env.GSHEET_ALLOW_ANY_URL)
    throw new Error("آدرس باید آدرس Web app اپس‌اسکریپت باشد (https://script.google.com/macros/s/…/exec)");
  // Apps Script answers POST with a redirect to the result; fetch follows it with GET
  const res = await httpFetch(url, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), redirect: "follow" } as any, proxy, 60_000);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    if (/accounts\.google\.com|ServiceLogin/i.test(text)) throw new Error("گوگل درخواست ورود کرد؛ در Deploy گزینهٔ «Who has access» را روی «Anyone» بگذارید.");
    throw new Error(`پاسخ نامعتبر از گوگل (HTTP ${res.status})`);
  }
  if (!json.ok) throw new Error(json.error || "خطای ناشناخته از اپس‌اسکریپت");
  return json as T;
}

// ------------------------------------------------------------------ which candidates go to the sheet
export const SheetRule = z.object({
  decisions: z.array(z.enum(["accepted", "partial", "rejected", "pending"])).default(["accepted", "partial"]),
  minScore: z.number().min(0).max(100).nullable().default(null),
  maxScore: z.number().min(0).max(100).nullable().default(null),
  minYears: z.number().min(0).nullable().default(null),
  maxExperienceAlerts: z.number().min(0).nullable().default(null), // 0 = only clean work histories
  cities: z.array(z.string()).default([]), // empty = any city
  excludeRejectedOnSite: z.boolean().default(true),
  onlyWithAttachment: z.boolean().default(false),
});
export type SheetRule = z.infer<typeof SheetRule>;

export interface RuleInput {
  decision: string;
  score: number | null;
  years: number | null;
  experienceAlerts: number;
  city: string | null;
  siteStatus: string | null;
  hasAttachment: boolean;
}

const norm = (s: string) => s.replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ").trim();

export function ruleMatches(rule: SheetRule, c: RuleInput): boolean {
  if (rule.decisions.length && !rule.decisions.includes(c.decision as any)) return false;
  if (rule.minScore != null && (c.score == null || c.score < rule.minScore)) return false;
  if (rule.maxScore != null && (c.score == null || c.score > rule.maxScore)) return false;
  if (rule.minYears != null && (c.years == null || c.years < rule.minYears)) return false;
  if (rule.maxExperienceAlerts != null && c.experienceAlerts > rule.maxExperienceAlerts) return false;
  if (rule.cities.length && !(c.city && rule.cities.some((x) => norm(c.city!).includes(norm(x))))) return false;
  if (rule.excludeRejectedOnSite && c.siteStatus === "rejected") return false;
  if (rule.onlyWithAttachment && !c.hasAttachment) return false;
  return true;
}

const FA_DEC: Record<string, string> = { accepted: "قبول", partial: "تایید نسبی", rejected: "رد", pending: "بررسی‌نشده" };
const n = (x: number) => x.toLocaleString("fa-IR", { useGrouping: false });

/** Human-readable Persian description of a rule (shown for confirmation). */
export function describeRule(r: SheetRule): string[] {
  const out = [`وضعیت: ${r.decisions.length ? r.decisions.map((d) => FA_DEC[d]).join("، ") : "همه"}`];
  if (r.minScore != null) out.push(`امتیاز حداقل ${n(r.minScore)}`);
  if (r.maxScore != null) out.push(`امتیاز حداکثر ${n(r.maxScore)}`);
  if (r.minYears != null) out.push(`سابقهٔ کار حداقل ${n(r.minYears)} سال`);
  if (r.maxExperienceAlerts === 0) out.push("بدون هشدار در سوابق کاری");
  else if (r.maxExperienceAlerts != null) out.push(`حداکثر ${n(r.maxExperienceAlerts)} هشدار سوابق کاری`);
  if (r.cities.length) out.push(`شهر: ${r.cities.join("، ")}`);
  if (r.onlyWithAttachment) out.push("فقط کسانی که فایل رزومه پیوست کرده‌اند");
  if (r.excludeRejectedOnSite) out.push("به‌جز کسانی که در جاب‌ویژن رد شده‌اند");
  return out;
}

export const RULE_PROMPT = `You convert an employer's plain-language condition (Persian) into a JSON filter for which job applicants get copied to their Google Sheet.
Reply with ONE JSON object only:
{"decisions": subset of ["accepted","partial","rejected","pending"] (accepted=قبول، partial=تایید نسبی، rejected=رد، pending=بررسی‌نشده; default ["accepted","partial"]),
 "minScore": number|null, "maxScore": number|null, "minYears": number|null,
 "maxExperienceAlerts": number|null (0 = only people without gaps/field switches/overlaps in their work history),
 "cities": [city names] (empty = any), "excludeRejectedOnSite": boolean (default true), "onlyWithAttachment": boolean}
Only set what the employer asked for; keep defaults otherwise.`;

// ------------------------------------------------------------------ mapping our fields to the sheet's columns
export const SHEET_FIELDS: Record<string, string> = {
  rowNumber: "شمارهٔ ردیف (ادامهٔ شماره‌های شیت)",
  name: "نام کارجو",
  phone: "تلفن",
  source: "منبع",
  receivedAt: "تاریخ دریافت رزومه",
  syncedAt: "تاریخ ثبت در شیت",
  unit: "نام واحد",
  jobTitle: "عنوان شغلی",
  resumeType: "نوع رزومه",
  status: "وضعیت",
  score: "امتیاز",
  years: "سابقه (سال)",
  lastJob: "آخرین شغل",
  education: "تحصیلات",
  city: "شهر",
  salary: "حقوق درخواستی",
  summary: "خلاصه",
  strengths: "نقاط قوت",
  weaknesses: "نقاط ضعف",
  alerts: "هشدارها",
  profileUrl: "لینک پروفایل",
};

export const MAPPING_PROMPT = `You map the columns of an employer's Google Sheet to the fields an ATS can provide.
Reply with ONE JSON object: {"<exact header text>": "<field key>" | null, ...} for EVERY header.
Field keys: ${Object.entries(SHEET_FIELDS).map(([k, v]) => `${k} (${v})`).join(", ")}.
Use rowNumber for a row-number column (ردیف / شماره). Use null when no field fits (that column is left empty). Never use one field for two unrelated columns.`;

/** Normalise a key value (phone numbers especially) so "+98 912…" and "0912…" compare equal. */
export function normKey(v: unknown): string {
  let s = String(v ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 13 && /^[\d\s+()-]+$/.test(s.trim())) {
    // phone: keep the last 10 digits (9xxxxxxxxx)
    return digits.slice(-10);
  }
  s = norm(s).toLowerCase();
  return s;
}
