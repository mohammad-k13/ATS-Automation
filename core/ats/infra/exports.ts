/**
 * Excel exports requested in the chat.
 * The AI never writes table data itself: it returns a small spec (which candidates, which columns, optional
 * extra columns with its own notes), and the server fills the cells from the database. So values are real,
 * and private fields such as the phone number go into the file without ever being sent to the AI.
 */
import { z } from 'zod';
import type { Row } from './db';

export const EXPORT_COLUMNS: Record<string, string> = {
      name: 'نام کارجو',
      phone: 'تلفن',
      source: 'منبع',
      receivedAt: 'تاریخ دریافت رزومه',
      unit: 'نام واحد',
      jobTitle: 'عنوان شغلی',
      resumeType: 'نوع رزومه',
      status: 'وضعیت',
      score: 'امتیاز',
      years: 'سابقه (سال)',
      lastJob: 'آخرین شغل',
      education: 'تحصیلات',
      city: 'شهر',
      salary: 'حقوق درخواستی',
      summary: 'خلاصه',
      strengths: 'نقاط قوت',
      weaknesses: 'نقاط ضعف',
      alerts: 'هشدارها',
      profileUrl: 'لینک پروفایل',
};

const STATUS_FA: Record<string, string> = {
      accepted: 'قبول',
      partial: 'تایید نسبی',
      rejected: 'رد',
      pending: 'بررسی‌نشده',
      error: 'خطا',
};
const PLATFORM_FA: Record<string, string> = { jobvision: 'جاب‌ویژن', jobinja: 'جابینجا' };

const Spec = z.object({
      title: z.string().trim().min(1).max(120).default('گزارش'),
      ids: z.array(z.coerce.string()).optional(),
      status: z.array(z.enum(['accepted', 'partial', 'rejected', 'pending', 'error'])).optional(),
      columns: z.array(z.string()).min(1),
      extra: z
            .array(
                  z.object({
                        label: z.string().trim().min(1).max(60),
                        values: z.record(z.string(), z.coerce.string()),
                  }),
            )
            .max(5)
            .optional(),
      sort: z.enum(['score', 'name', 'receivedAt']).optional(),
});
export type ExportSpec = z.infer<typeof Spec>;

export interface ExportTable {
      id: string;
      title: string;
      columns: string[];
      rows: (string | number)[][];
}

/** Jalali yyyy/mm/dd */
export function jalaliDate(iso: string | null | undefined): string {
      if (!iso) return '';
      const p = new Intl.DateTimeFormat('en-US-u-ca-persian', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
      }).formatToParts(new Date(iso));
      const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
      return `${get('year').replace(/\D/g, '')}/${get('month')}/${get('day')}`;
}

const parse = (s: string | null) => {
      try {
            return s ? JSON.parse(s) : null;
      } catch {
            return null;
      }
};

/** One field of one candidate, for Excel exports and the Google Sheet. */
export function fieldValue(
      key: string,
      r: Row & { unit?: string | null },
      unit: string,
): string | number {
      const ex = parse(r.extra_json) ?? {};
      const res = parse(r.result_json) ?? {};
      const scored =
            r.decision === 'accepted' || r.decision === 'partial' || r.decision === 'rejected';
      switch (key) {
            case 'name':
                  return r.name ?? '';
            case 'phone':
                  return r.phone ?? '';
            case 'source':
                  return PLATFORM_FA[r.source] ?? r.source;
            case 'receivedAt':
                  return jalaliDate(r.applied_at);
            case 'unit':
                  return unit;
            case 'jobTitle':
                  return r.job ?? '';
            case 'resumeType':
                  return ex.resumeType ?? '';
            case 'status':
                  return STATUS_FA[r.decision] ?? r.decision;
            case 'score':
                  return scored && r.score != null ? r.score : '';
            case 'years':
                  return ex.totalWorkExperienceYears ?? '';
            case 'lastJob':
                  return ex.lastJob ?? '';
            case 'education':
                  return ex.lastEducation ?? '';
            case 'city':
                  return ex.city ?? '';
            case 'salary':
                  return ex.requestedSalary ?? '';
            case 'summary':
                  return res.summary ?? '';
            case 'strengths':
                  return (res.matched ?? []).join('، ');
            case 'weaknesses':
                  return (res.missing ?? []).join('، ');
            case 'alerts':
                  return [...(ex.experienceAlerts ?? []), ...(res.redFlags ?? [])].join('؛ ');
            case 'profileUrl':
                  return r.profile_url ?? '';
            default:
                  return '';
      }
}

/** Build one table from a spec and the job's rows. */
export function buildExport(specInput: unknown, rows: Row[], unit: string): ExportTable {
      const spec = Spec.parse(specInput);
      const columns = spec.columns.filter((c) => c in EXPORT_COLUMNS);
      if (!columns.length)
            throw new Error(
                  `ستون معتبری انتخاب نشده (مجاز: ${Object.keys(EXPORT_COLUMNS).join(', ')})`,
            );
      let list = rows;
      if (spec.ids?.length) {
            const order = new Map(spec.ids.map((id, i) => [id, i]));
            list = rows
                  .filter((r) => order.has(r.id))
                  .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      }
      if (spec.status?.length) list = list.filter((r) => spec.status!.includes(r.decision as any));
      if (spec.sort === 'score') list = [...list].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      if (spec.sort === 'name')
            list = [...list].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'fa'));
      if (spec.sort === 'receivedAt')
            list = [...list].sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? ''));
      const extra = spec.extra ?? [];
      return {
            id: Math.random().toString(36).slice(2, 10),
            title: spec.title,
            columns: [
                  'ردیف',
                  ...columns.map((c) => EXPORT_COLUMNS[c]),
                  ...extra.map((e) => e.label),
            ],
            rows: list.map((r, i) => [
                  i + 1,
                  ...columns.map((c) => fieldValue(c, r, unit)),
                  ...extra.map((e) => e.values[r.id] ?? ''),
            ]),
      };
}

const BLOCK = /```(?:excel|xlsx)\s*\n([\s\S]*?)```/gi;

/** Take ```excel blocks out of an AI answer and turn them into tables. */
export function extractExports(
      answer: string,
      rows: Row[],
      unit: string,
): { text: string; exports: ExportTable[]; errors: string[] } {
      const exports: ExportTable[] = [];
      const errors: string[] = [];
      const text = answer
            .replace(BLOCK, (_, json: string) => {
                  try {
                        exports.push(buildExport(JSON.parse(json), rows, unit));
                  } catch (e) {
                        errors.push(e instanceof Error ? e.message : String(e));
                  }
                  return '';
            })
            .trim();
      return { text, exports, errors };
}

/** Instructions for the AI on how to ask for an Excel file. */
export const EXPORT_INSTRUCTIONS = `## خروجی اکسل
اگر کاربر فایل اکسل، جدول قابل دانلود یا گزارش خواست، علاوه بر توضیح کوتاه، یک بلوک با این شکل بگذار (دقیقاً با \`\`\`excel):
\`\`\`excel
{"title": "عنوان گزارش", "ids": ["شناسهٔ رزومه‌ها به ترتیب دلخواه"], "status": ["accepted","partial"], "columns": ["name","phone","score"], "sort": "score",
 "extra": [{"label": "دلیل انتخاب", "values": {"<id>": "متن کوتاه"}}]}
\`\`\`
- خودت داده ننویس؛ سیستم خانه‌ها را از پایگاه داده پر می‌کند (تلفن را هم سیستم اضافه می‌کند).
- یا ids (فقط شناسه‌های موجود در فهرست) یا status یا هر دو. اگر هیچ‌کدام نباشد همهٔ رزومه‌ها می‌آیند.
- columns فقط از این‌ها: ${Object.entries(EXPORT_COLUMNS)
      .map(([k, v]) => `${k} (${v})`)
      .join('، ')}.
- extra برای ستون‌هایی که نظر خودت است (حداکثر ۵ ستون)؛ کلید values همان id رزومه است.
- sort یکی از score، name، receivedAt.
برای جدول‌های کوچک داخل گفتگو از جدول مارک‌داون استفاده کن.`;
