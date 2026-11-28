'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { downloadXlsx } from '@/core/ats/infra/xlsx';
import { useApi } from '../lib/cache';

interface Row {
    name: string;
    source: string;
    phone: string;
    receivedAt: string | null;
    unit: string;
    jobTitle: string;
    resumeType: string;
    status: string;
    score: number | null;
}
interface Report {
    generatedAt: string;
    filter: { job: string | null; status: string; selected: number };
    rows: Row[];
}

const COLS: [keyof Row, string][] = [
    ['name', 'نام کارجو'],
    ['source', 'منبع'],
    ['phone', 'تلفن'],
    ['receivedAt', 'تاریخ دریافت رزومه'],
    ['unit', 'نام واحد'],
    ['jobTitle', 'عنوان شغلی'],
    ['resumeType', 'نوع رزومه'],
    ['score', 'امتیاز'],
];
const faDigits = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
/** Jalali date as yyyy/mm/dd, e.g. 1405/08/25 (Latin digits, also in Excel so it sorts and filters well). */
const jalali = (s: string | null) => {
    if (!s) return '-';
    const p = new Intl.DateTimeFormat('en-US-u-ca-persian', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(s));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
    return `${get('year').replace(/\D/g, '')}/${get('month')}/${get('day')}`;
};
const faDay = jalali;
const cell = (r: Row, k: keyof Row) =>
    k === 'receivedAt'
        ? faDay(r.receivedAt)
        : k === 'phone'
          ? r.phone
              ? faDigits(r.phone)
              : '-'
          : k === 'score'
            ? r.score != null
                ? r.score.toLocaleString('fa-IR')
                : '—'
            : String(r[k] ?? '') || '-';

function ReportView() {
    const q = useSearchParams();
    const src = q.get('src') ?? 'jobvision';
    const p = new URLSearchParams();
    for (const k of ['job', 'status', 'ids']) if (q.get(k)) p.set(k, q.get(k)!);
    const r = useApi<Report>(`platforms/${src}/report?${p}`);
    const rep = r.data ?? null;
    const err = r.error?.message ?? '';

    const csv = () => {
        if (!rep) return;
        const rows = rep.rows.map((r, i) => [
            i + 1,
            ...COLS.map(([k]) =>
                k === 'receivedAt' ? faDay(r.receivedAt) : k === 'score' ? (r.score ?? '') : String(r[k] ?? ''),
            ),
        ]);
        downloadXlsx(`گزارش رزومه ${new Date().toISOString().slice(0, 10)}`, ['ردیف', ...COLS.map(([, l]) => l)], rows);
    };

    if (err) return <div className="notice bad">{err}</div>;
    if (!rep) return <div className="empty">در حال آماده‌سازی گزارش…</div>;
    const title = rep.filter.job ? `گزارش رزومه‌های «${rep.filter.job}»` : 'گزارش رزومه‌ها';
    return (
        <div className="report">
            <div className="report-actions no-print">
                <span className="grow" />
                <button className="btn" onClick={csv}>
                    دانلود اکسل
                </button>
                <button className="btn primary" onClick={() => window.print()}>
                    چاپ / ذخیره PDF
                </button>
            </div>

            <div className="report-sheet">
                <header className="report-head">
                    <div>
                        <h1>{title}</h1>
                        <div className="report-meta">
                            <span>وضعیت: {rep.filter.status}</span>
                            {rep.filter.selected > 0 && (
                                <span>{rep.filter.selected.toLocaleString('fa-IR')} رزومهٔ انتخاب‌شده</span>
                            )}
                            <span>تعداد: {rep.rows.length.toLocaleString('fa-IR')} نفر</span>
                        </div>
                    </div>
                    <div className="report-date">
                        <div>تاریخ گزارش</div>
                        <b className="ltr">{faDay(rep.generatedAt)}</b>
                    </div>
                </header>

                {rep.rows.length ? (
                    <table className="report-table">
                        <thead>
                            <tr>
                                <th style={{ width: 70 }}>ردیف</th>
                                {COLS.map(([k, l]) => (
                                    <th key={k} style={k === 'score' ? { textAlign: 'center', width: 90 } : undefined}>
                                        {l}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rep.rows.map((r, i) => (
                                <tr key={i}>
                                    <td className="num">{(i + 1).toLocaleString('fa-IR')}</td>
                                    {COLS.map(([k]) => (
                                        <td
                                            key={k}
                                            className={
                                                k === 'name'
                                                    ? 'strong'
                                                    : k === 'phone' || k === 'receivedAt'
                                                      ? 'nowrap'
                                                      : k === 'score'
                                                        ? `score-cell ${r.status === 'قبول' ? 'ok' : r.status === 'تایید نسبی' ? 'partial' : r.status === 'رد' ? 'bad' : ''}`
                                                        : ''
                                            }
                                        >
                                            {cell(r, k)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="empty">رزومه‌ای با این شرایط وجود ندارد.</div>
                )}
            </div>
        </div>
    );
}

export default function ReportPage() {
    return (
        <Suspense fallback={<div className="empty">…</div>}>
            <ReportView />
        </Suspense>
    );
}
