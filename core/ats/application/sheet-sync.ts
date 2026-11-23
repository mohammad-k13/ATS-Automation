/** Google Sheet connection, column mapping, the "who should be added" rule, and syncing. */
import { randomUUID } from 'node:crypto';
import {
      appsScript,
      callSheet,
      describeRule,
      MAPPING_PROMPT,
      normKey,
      RULE_PROMPT,
      ruleReason,
      SHEET_FIELDS,
      SheetRule,
} from '../infra/gsheet';
import { getChat } from '../infra/ai';
import { fieldValue, jalaliDate } from '../infra/exports';
import { writeEnv } from '../infra/auth/token';
import { db, parse, UserError } from './state';

const env = process.env;

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
const SHEET_KEY = 'gsheet';
const sheetDefaults = (): SheetConfig => ({
      url: '',
      sheet: '',
      headers: [],
      mapping: {},
      keyColumn: null,
      conditionText: '',
      rule: SheetRule.parse({}),
      autoSync: false,
});
export function sheetConfig(): SheetConfig {
      return { ...sheetDefaults(), ...(db().getKv<SheetConfig>(SHEET_KEY)?.value ?? {}) };
}
export function sheetSecret(): string {
      if (!env.GSHEET_SECRET) writeEnv('GSHEET_SECRET', randomUUID().replace(/-/g, ''));
      return env.GSHEET_SECRET!;
}

export function getSheetSettings() {
      const c = sheetConfig();
      return {
            ...c,
            ruleText: describeRule(c.rule),
            script: appsScript(sheetSecret()),
            fields: SHEET_FIELDS,
      };
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
      if (!url) throw new UserError('آدرس Web app را وارد کنید');
      let info: { sheets: string[]; sheet: string; headers: string[]; rows: number; title: string };
      try {
            info = await callSheet(url, {
                  secret: sheetSecret(),
                  action: 'info',
                  sheet: input.sheet ?? c.sheet ?? '',
            });
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
      if (!c.headers.length)
            throw new UserError('اول اتصال را آزمایش کنید تا ستون‌های شیت خوانده شود');
      const chat = getChat();
      if (!chat) throw new UserError('هوش مصنوعی تنظیم نشده');
      const raw = await chat(
            MAPPING_PROMPT,
            [{ role: 'user', content: `HEADERS: ${JSON.stringify(c.headers)}` }],
            1000,
      );
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const mapping = Object.fromEntries(
            c.headers.map((h) => [
                  h,
                  typeof json[h] === 'string' && json[h] in SHEET_FIELDS ? json[h] : null,
            ]),
      );
      const keyColumn = c.keyColumn ?? c.headers.find((h) => mapping[h] === 'phone') ?? null;
      return saveSheetSettings({ mapping, keyColumn });
}

/** Turn the plain-language condition into a rule (not saved until the user confirms). */
export async function sheetRuleFromText(text: string) {
      if (!text.trim()) throw new UserError('شرط را بنویسید');
      const chat = getChat();
      if (!chat) throw new UserError('هوش مصنوعی تنظیم نشده');
      const raw = await chat(RULE_PROMPT, [{ role: 'user', content: text }], 600);
      const rule = SheetRule.parse(
            JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)),
      );
      return { rule, ruleText: describeRule(rule) };
}

/** Candidates that match the rule, are not yet in the sheet, as rows in the sheet's column order. */
async function sheetPlan(src: string, jobId?: string) {
      const c = sheetConfig();
      if (!c.url || !c.headers.length)
            throw new UserError('اتصال گوگل شیت هنوز تنظیم نشده (تنظیمات و اتصال‌ها)');
      if (!Object.values(c.mapping).some(Boolean))
            throw new UserError('هیچ ستونی به داده‌ای وصل نشده؛ نگاشت ستون‌ها را تنظیم کنید');
      const all = db().report(src, { jobId });
      // everyone is either added or listed with a reason (only scored people are listed, not pending/errors)
      const skipped: { name: string; reason: string }[] = [];
      const listWorthy = (d: string) =>
            d === 'accepted' || d === 'partial' || c.rule.decisions.includes(d as any);
      const candidates = all.filter((r) => {
            const ex = parse(r.extra_json) ?? {};
            if (r.gsheet_synced_at) {
                  if (listWorthy(r.decision))
                        skipped.push({
                              name: r.name,
                              reason: `قبلاً در ${jalaliDate(r.gsheet_synced_at)} به شیت اضافه شده`,
                        });
                  return false;
            }
            const why = ruleReason(c.rule, {
                  decision: r.decision,
                  score: r.score,
                  years: ex.totalWorkExperienceYears ?? null,
                  experienceAlerts: (ex.experienceAlerts ?? []).length,
                  city: ex.city ?? null,
                  siteStatus: r.site_status,
                  hasAttachment: !!(ex.personalCvFileId || r.resume_url),
            });
            if (why && listWorthy(r.decision)) skipped.push({ name: r.name, reason: why });
            return !why;
      });
      // people already in the sheet (by the key column)
      let existing = new Map<string, string>(); // key -> who/where
      const keyField = c.keyColumn ? c.mapping[c.keyColumn] : null;
      if (c.keyColumn && keyField) {
            const res = await callSheet<{ values: string[] }>(c.url, {
                  secret: sheetSecret(),
                  action: 'keys',
                  sheet: c.sheet,
                  column: c.keyColumn,
            });
            existing = new Map(
                  res.values
                        .map((v) => [normKey(v), 'شیت'] as [string, string])
                        .filter(([k]) => !!k),
            );
      }
      const today = jalaliDate(new Date().toISOString());
      const value = (field: string | null, r: (typeof all)[number]) =>
            !field || field === 'rowNumber'
                  ? ''
                  : field === 'syncedAt'
                    ? today
                    : String(fieldValue(field, r, r.unit ?? '') ?? '');
      const toAdd: typeof all = [];
      const alreadyInSheet: typeof all = [];
      for (const r of candidates) {
            const key = keyField ? normKey(value(keyField, r)) : '';
            const seen = key ? existing.get(key) : undefined;
            if (seen === 'شیت') {
                  alreadyInSheet.push(r);
                  skipped.push({ name: r.name, reason: `از قبل در شیت هست (همان ${c.keyColumn})` });
            } else if (seen) {
                  skipped.push({
                        name: r.name,
                        reason: `تکراری: همان ${c.keyColumn} با «${seen}» (احتمالاً دو بار درخواست داده)`,
                  });
            } else {
                  toAdd.push(r);
                  if (key) existing.set(key, r.name);
            }
      }
      // row numbers continue after the last number found in the sheet's row-number column
      let nextNo = 1;
      const noColumn = c.headers.find((h) => c.mapping[h] === 'rowNumber');
      if (noColumn && toAdd.length) {
            const res = await callSheet<{ values: string[] }>(c.url, {
                  secret: sheetSecret(),
                  action: 'keys',
                  sheet: c.sheet,
                  column: noColumn,
            });
            const nums = res.values
                  .map((v) => Number(normKey(v).replace(/\D/g, '')))
                  .filter((x) => Number.isFinite(x) && x > 0);
            nextNo = (nums.length ? Math.max(...nums) : res.values.length) + 1;
      }
      const rows = toAdd.map((r, i) =>
            c.headers.map((h) =>
                  c.mapping[h] === 'rowNumber'
                        ? String(nextNo + i)
                        : value(c.mapping[h] ?? null, r),
            ),
      );
      return { c, toAdd, alreadyInSheet, rows, skipped };
}

export async function previewSheet(src: string, jobId?: string) {
      try {
            const p = await sheetPlan(src, jobId);
            return {
                  headers: p.c.headers,
                  rows: p.rows.slice(0, 50),
                  count: p.rows.length,
                  alreadyInSheet: p.alreadyInSheet.length,
                  ruleText: describeRule(p.c.rule),
                  skipped: p.skipped,
            };
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
      db().markSheetSynced(
            src,
            p.alreadyInSheet.map((r) => r.id),
      );
      if (!p.rows.length) return { added: 0, alreadyInSheet: p.alreadyInSheet.length };
      for (let i = 0; i < p.rows.length; i += 200) {
            try {
                  await callSheet(p.c.url, {
                        secret: sheetSecret(),
                        action: 'append',
                        sheet: p.c.sheet,
                        rows: p.rows.slice(i, i + 200),
                  });
            } catch (e) {
                  throw new UserError(
                        `افزودن به شیت ناموفق بود: ${e instanceof Error ? e.message : e}`,
                        502,
                  );
            }
            db().markSheetSynced(
                  src,
                  p.toAdd.slice(i, i + 200).map((r) => r.id),
            );
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
