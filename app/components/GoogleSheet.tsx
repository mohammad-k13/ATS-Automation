'use client';
import { useEffect, useState } from 'react';
import { api, fa, type Status } from '../lib/api';
import { useApi } from '../lib/cache';
import TagsInput from './TagsInput';

interface Rule {
    decisions: string[];
    minScore: number | null;
    maxScore: number | null;
    minYears: number | null;
    maxExperienceAlerts: number | null;
    cities: string[];
    excludeRejectedOnSite: boolean;
    onlyWithAttachment: boolean;
}
interface Settings {
    url: string;
    sheet: string;
    headers: string[];
    mapping: Record<string, string | null>;
    keyColumn: string | null;
    conditionText: string;
    rule: Rule;
    ruleText: string[];
    autoSync: boolean;
    script: string;
    fields: Record<string, string>;
}
interface Preview {
    headers: string[];
    rows: string[][];
    count: number;
    alreadyInSheet: number;
    ruleText: string[];
    skipped: { name: string; reason: string }[];
}
type Msg = { cls: string; text: string } | null;

export default function GoogleSheet() {
    const q = useApi<Settings>('gsheet', { revalidateOnFocus: false });
    const st = useApi<Status>('status').data;
    const src = st?.platforms[0]?.name ?? 'jobvision';
    const d = q.data;
    const [url, setUrl] = useState('');
    const [sheets, setSheets] = useState<string[]>([]);
    const [info, setInfo] = useState<{ title: string; rows: number } | null>(null);
    const [mapping, setMapping] = useState<Record<string, string | null>>({});
    const [keyColumn, setKeyColumn] = useState<string | null>(null);
    const [cond, setCond] = useState('');
    const [rule, setRule] = useState<Rule | null>(null);
    const [busy, setBusy] = useState('');
    const [msg, setMsg] = useState<Msg>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [showScript, setShowScript] = useState(false);

    useEffect(() => {
        if (!d) return;
        setUrl(d.url);
        setMapping(d.mapping);
        setKeyColumn(d.keyColumn);
        setCond(d.conditionText);
        setRule(d.rule);
    }, [d]);

    const run = async (name: string, fn: () => Promise<void>) => {
        setBusy(name);
        setMsg(null);
        try {
            await fn();
        } catch (e: any) {
            setMsg({ cls: 'bad', text: e.message });
        } finally {
            setBusy('');
        }
    };
    const save = (patch: Partial<Settings>) =>
        run('save', async () => {
            await q.mutate(await api<Settings>('gsheet', { method: 'PUT', body: patch }), {
                revalidate: false,
            });
            setMsg({ cls: 'ok', text: 'ذخیره شد.' });
        });

    if (!d)
        return (
            <section className="panel panel-pad">
                <div className="skeleton" style={{ height: 160 }} />
            </section>
        );
    const connected = !!d.url && d.headers.length > 0;
    const mappingDirty = JSON.stringify(mapping) !== JSON.stringify(d.mapping) || keyColumn !== d.keyColumn;
    const ruleDirty = !!rule && JSON.stringify(rule) !== JSON.stringify(d.rule);

    return (
        <section className="panel panel-pad stack" style={{ gap: 18 }}>
            <div>
                <h2>گوگل شیت</h2>
                <div className="small muted">
                    کارجوهایی که شرط شما را دارند به شیت موجودتان اضافه می‌شوند؛ هیچ‌کس دو بار اضافه نمی‌شود.
                </div>
            </div>

            {/* 1. connect */}
            <div className="stack" style={{ gap: 10 }}>
                <h3>۱. اتصال</h3>
                <button
                    className="btn sm ghost"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => setShowScript(!showScript)}
                >
                    {showScript ? 'بستن راهنما' : 'راهنمای اتصال (یک‌بار)'}
                </button>
                {showScript && (
                    <div className="stack small" style={{ gap: 8 }}>
                        <ol style={{ margin: 0, paddingInlineStart: 18, lineHeight: 2 }}>
                            <li>
                                شیت را باز کنید ← <b>Extensions</b> ← <b>Apps Script</b>.
                            </li>
                            <li>همهٔ کد پیش‌فرض را پاک کنید، کد زیر را بچسبانید و ذخیره کنید.</li>
                            <li>
                                <b>Deploy</b> ← <b>New deployment</b> ← نوع <b>Web app</b>؛ «Execute as»: <b>Me</b>،
                                «Who has access»: <b>Anyone</b> ← <b>Deploy</b> و دسترسی‌ها را تأیید کنید.
                            </li>
                            <li>
                                آدرس <b>Web app URL</b> را کپی کنید و پایین وارد کنید.
                            </li>
                        </ol>
                        <div className="row">
                            <button
                                className="btn sm"
                                onClick={() =>
                                    navigator.clipboard
                                        .writeText(d.script)
                                        .then(() => setMsg({ cls: 'ok', text: 'کد کپی شد.' }))
                                }
                            >
                                کپی کد
                            </button>
                            <span className="faint">
                                کلید امنیتی داخل کد مخصوص سامانهٔ شماست؛ آن را با کسی به اشتراک نگذارید.
                            </span>
                        </div>
                        <pre
                            className="code"
                            style={{
                                maxHeight: 220,
                                overflow: 'auto',
                                background: 'var(--bg)',
                                padding: 10,
                                borderRadius: 8,
                                margin: 0,
                            }}
                        >
                            {d.script}
                        </pre>
                    </div>
                )}
                <div className="row">
                    <input
                        className="input ltr"
                        style={{ textAlign: 'left' }}
                        placeholder="https://script.google.com/macros/s/…/exec"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                    <button
                        className="btn"
                        disabled={!url || busy !== ''}
                        onClick={() =>
                            run('test', async () => {
                                const r = await api<{
                                    sheets: string[];
                                    sheet: string;
                                    headers: string[];
                                    rows: number;
                                    title: string;
                                }>('gsheet/test', { body: { url } });
                                setSheets(r.sheets);
                                setInfo({ title: r.title, rows: r.rows });
                                await q.mutate();
                                setMsg({
                                    cls: 'ok',
                                    text: `وصل شد: «${r.title}» — برگهٔ «${r.sheet}»، ${fa(r.headers.length)} ستون، ${fa(r.rows)} ردیف.`,
                                });
                            })
                        }
                    >
                        {busy === 'test' ? 'در حال اتصال…' : 'آزمایش اتصال'}
                    </button>
                </div>
                {(sheets.length > 1 || d.sheet) && (
                    <label className="row small">
                        <span>برگه:</span>
                        <select
                            className="input"
                            style={{ width: 'auto' }}
                            value={d.sheet}
                            onChange={(e) =>
                                run('test', async () => {
                                    const r = await api<{ sheets: string[]; title: string; rows: number }>(
                                        'gsheet/test',
                                        { body: { url: d.url, sheet: e.target.value } },
                                    );
                                    setSheets(r.sheets);
                                    setInfo({ title: r.title, rows: r.rows });
                                    await q.mutate();
                                })
                            }
                        >
                            {(sheets.length ? sheets : [d.sheet]).map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                        {info && <span className="faint">{fa(info.rows)} ردیف دارد</span>}
                    </label>
                )}
            </div>

            {/* steps 2–4 preview until connected, so it is clear what comes next */}
            {!connected && (
                <div className="stack" style={{ gap: 12, opacity: 0.55 }}>
                    <div>
                        <h3>۲. ستون‌های شیت</h3>
                        <div className="small muted">
                            هوش مصنوعی ستون‌های شیت شما را می‌خواند و پیشنهاد می‌دهد در هر ستون چه نوشته شود (نام، تلفن،
                            امتیاز…).
                        </div>
                    </div>
                    <div>
                        <h3>۳. شرط اضافه شدن به شیت</h3>
                        <div className="small muted">
                            به زبان ساده بنویسید چه کسانی اضافه شوند؛ مثلاً «قبول و تایید نسبی با امتیاز بالای ۶۰».
                        </div>
                    </div>
                    <div>
                        <h3>۴. ارسال</h3>
                        <div className="small muted">پیش‌نمایش، افزودن به شیت، و ارسال خودکار بعد از هر امتیازدهی.</div>
                    </div>
                    <div className="notice" style={{ opacity: 1 }}>
                        این مراحل بعد از «آزمایش اتصال» موفق فعال می‌شوند. اول کد را در شیت اضافه کنید («راهنمای اتصال»
                        بالا).
                    </div>
                </div>
            )}

            {/* 2. columns */}
            {connected && (
                <div className="stack" style={{ gap: 10 }}>
                    <div className="row between">
                        <h3>۲. ستون‌های شیت</h3>
                        <button
                            className="btn sm"
                            disabled={busy !== ''}
                            onClick={() =>
                                run('map', async () => {
                                    const r = await api<Settings>('gsheet/mapping/suggest', { body: {} });
                                    await q.mutate(r, { revalidate: false });
                                    setMapping(r.mapping);
                                    setKeyColumn(r.keyColumn);
                                    setMsg({ cls: '', text: 'پیشنهاد هوش مصنوعی اعمال شد؛ بررسی و ذخیره کنید.' });
                                })
                            }
                        >
                            {busy === 'map' ? 'در حال پیشنهاد…' : 'پیشنهاد با هوش مصنوعی'}
                        </button>
                    </div>
                    <div className="md-table">
                        <table>
                            <thead>
                                <tr>
                                    <th>ستون شیت</th>
                                    <th>چه داده‌ای در آن نوشته شود</th>
                                </tr>
                            </thead>
                            <tbody>
                                {d.headers.map((h) => (
                                    <tr key={h}>
                                        <td>
                                            <b>{h}</b>
                                        </td>
                                        <td>
                                            <select
                                                className="input"
                                                style={{ padding: '4px 8px' }}
                                                value={mapping[h] ?? ''}
                                                onChange={(e) =>
                                                    setMapping({ ...mapping, [h]: e.target.value || null })
                                                }
                                            >
                                                <option value="">— خالی بماند —</option>
                                                {Object.entries(d.fields).map(([k, v]) => (
                                                    <option key={k} value={k}>
                                                        {v}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <label className="row small">
                        <span>تشخیص تکراری با ستون:</span>
                        <select
                            className="input"
                            style={{ width: 'auto' }}
                            value={keyColumn ?? ''}
                            onChange={(e) => setKeyColumn(e.target.value || null)}
                        >
                            <option value="">— بدون بررسی شیت —</option>
                            {d.headers
                                .filter((h) => mapping[h])
                                .map((h) => (
                                    <option key={h} value={h}>
                                        {h}
                                    </option>
                                ))}
                        </select>
                        <span className="faint">
                            کسی که مقدار این ستونش در شیت هست، دوباره اضافه نمی‌شود (پیشنهاد: تلفن)
                        </span>
                    </label>
                    <div>
                        <button
                            className="btn primary sm"
                            disabled={!mappingDirty || busy !== ''}
                            onClick={() => save({ mapping, keyColumn })}
                        >
                            ذخیرهٔ ستون‌ها
                        </button>
                    </div>
                </div>
            )}

            {/* 3. condition: a simple form; plain-language text only fills the form */}
            {connected && rule && (
                <div className="stack" style={{ gap: 12 }}>
                    <div className="row between">
                        <h3>۳. چه کسانی به شیت اضافه شوند؟</h3>
                        {ruleDirty && <span className="badge warn">ذخیره‌نشده</span>}
                    </div>
                    <div className="row wrap" style={{ gap: 14 }}>
                        <span className="small" style={{ fontWeight: 600 }}>
                            وضعیت:
                        </span>
                        {(
                            [
                                ['accepted', 'قبول'],
                                ['partial', 'تایید نسبی'],
                                ['rejected', 'رد'],
                                ['pending', 'بررسی‌نشده'],
                            ] as const
                        ).map(([k, l]) => (
                            <label key={k} className="row small" style={{ cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={rule.decisions.includes(k)}
                                    onChange={(e) =>
                                        setRule({
                                            ...rule,
                                            decisions: e.target.checked
                                                ? [...rule.decisions, k]
                                                : rule.decisions.filter((x) => x !== k),
                                        })
                                    }
                                />{' '}
                                {l}
                            </label>
                        ))}
                    </div>
                    <div className="grid2">
                        <label className="field">
                            <span>حداقل امتیاز</span>
                            <input
                                className="input"
                                type="number"
                                min={0}
                                max={100}
                                placeholder="بدون محدودیت"
                                value={rule.minScore ?? ''}
                                onChange={(e) =>
                                    setRule({
                                        ...rule,
                                        minScore: e.target.value === '' ? null : Number(e.target.value),
                                    })
                                }
                            />
                        </label>
                        <label className="field">
                            <span>حداقل سابقهٔ کار (سال)</span>
                            <input
                                className="input"
                                type="number"
                                min={0}
                                placeholder="بدون محدودیت"
                                value={rule.minYears ?? ''}
                                onChange={(e) =>
                                    setRule({
                                        ...rule,
                                        minYears: e.target.value === '' ? null : Number(e.target.value),
                                    })
                                }
                            />
                        </label>
                    </div>
                    <label className="field">
                        <span>فقط این شهرها</span>
                        <TagsInput
                            value={rule.cities}
                            onChange={(v) => setRule({ ...rule, cities: v })}
                            placeholder="خالی = همهٔ شهرها"
                        />
                    </label>
                    <div className="stack" style={{ gap: 6 }}>
                        <label className="row small" style={{ cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={rule.maxExperienceAlerts === 0}
                                onChange={(e) => setRule({ ...rule, maxExperienceAlerts: e.target.checked ? 0 : null })}
                            />{' '}
                            فقط کسانی که در سوابق کاری فاصله، تغییر حوزه یا سابقهٔ همزمان ندارند
                        </label>
                        <label className="row small" style={{ cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={rule.onlyWithAttachment}
                                onChange={(e) => setRule({ ...rule, onlyWithAttachment: e.target.checked })}
                            />{' '}
                            فقط کسانی که فایل رزومه پیوست کرده‌اند
                        </label>
                        <label className="row small" style={{ cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={rule.excludeRejectedOnSite}
                                onChange={(e) => setRule({ ...rule, excludeRejectedOnSite: e.target.checked })}
                            />{' '}
                            کسانی که در جاب‌ویژن رد شده‌اند اضافه نشوند
                        </label>
                    </div>
                    <details>
                        <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>
                            یا شرط را به زبان ساده بنویسید تا فرم پر شود
                        </summary>
                        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                            <textarea
                                className="textarea"
                                rows={2}
                                value={cond}
                                onChange={(e) => setCond(e.target.value)}
                                placeholder="مثلاً: قبول و تایید نسبی با امتیاز بالای ۶۰ که ساکن اصفهان هستند"
                            />
                            <div>
                                <button
                                    className="btn sm"
                                    disabled={!cond.trim() || busy !== ''}
                                    onClick={() =>
                                        run('rule', async () => {
                                            const r = await api<{ rule: Rule }>('gsheet/rule', {
                                                body: { text: cond },
                                            });
                                            setRule(r.rule);
                                            setMsg({ cls: '', text: 'فرم پر شد؛ بررسی کنید و «ذخیرهٔ شرط» را بزنید.' });
                                        })
                                    }
                                >
                                    {busy === 'rule' ? 'در حال تبدیل…' : 'پر کردن فرم'}
                                </button>
                            </div>
                        </div>
                    </details>
                    <div>
                        <button
                            className="btn primary sm"
                            disabled={!ruleDirty || busy !== '' || !rule.decisions.length}
                            onClick={() => save({ rule, conditionText: cond })}
                        >
                            ذخیرهٔ شرط
                        </button>
                    </div>
                </div>
            )}

            {/* 4. send */}
            {connected && (
                <div className="stack" style={{ gap: 10 }}>
                    <h3>۴. ارسال</h3>
                    <label className="row between">
                        <span>
                            <b>ارسال خودکار</b>
                            <div className="small muted">
                                بعد از هر امتیازدهی، کارجوهای جدیدی که شرط را دارند به شیت اضافه می‌شوند.
                            </div>
                        </span>
                        <span className="switch">
                            <input
                                type="checkbox"
                                checked={d.autoSync}
                                onChange={(e) => save({ autoSync: e.target.checked })}
                            />
                            <span />
                        </span>
                    </label>
                    <div className="row">
                        <button
                            className="btn"
                            disabled={busy !== ''}
                            onClick={() =>
                                run('preview', async () =>
                                    setPreview(await api<Preview>(`platforms/${src}/gsheet/preview`, { body: {} })),
                                )
                            }
                        >
                            {busy === 'preview' ? 'در حال بررسی…' : 'پیش‌نمایش (همهٔ آگهی‌ها)'}
                        </button>
                        {preview && preview.count > 0 && (
                            <button
                                className="btn primary"
                                disabled={busy !== ''}
                                onClick={() =>
                                    run('sync', async () => {
                                        const r = await api<{ added: number; alreadyInSheet: number }>(
                                            `platforms/${src}/gsheet/sync`,
                                            { body: {} },
                                        );
                                        setPreview(null);
                                        setMsg({
                                            cls: 'ok',
                                            text: `${fa(r.added)} ردیف به شیت اضافه شد.${r.alreadyInSheet ? ` ${fa(r.alreadyInSheet)} نفر از قبل در شیت بودند.` : ''}`,
                                        });
                                    })
                                }
                            >
                                {busy === 'sync' ? 'در حال افزودن…' : `افزودن ${fa(preview.count)} ردیف به شیت`}
                            </button>
                        )}
                    </div>
                    {preview && (
                        <div className="stack" style={{ gap: 6 }}>
                            <div className="small">
                                {preview.count
                                    ? `${fa(preview.count)} ردیف جدید اضافه می‌شود`
                                    : 'ردیف جدیدی برای افزودن نیست'}
                                {preview.skipped.length ? ` · ${fa(preview.skipped.length)} نفر اضافه نمی‌شوند` : ''}
                            </div>
                            {preview.skipped.length > 0 && (
                                <details>
                                    <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>
                                        چه کسانی اضافه نمی‌شوند و چرا؟
                                    </summary>
                                    <ul className="small" style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                                        {preview.skipped.map((x, i) => (
                                            <li key={i}>
                                                <b>{x.name}</b>: {x.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                            {preview.count > 0 && (
                                <div className="md-table" style={{ maxHeight: 320, overflow: 'auto' }}>
                                    <table>
                                        <thead>
                                            <tr>
                                                {preview.headers.map((h) => (
                                                    <th key={h}>{h}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {preview.rows.map((r, i) => (
                                                <tr key={i}>
                                                    {r.map((v, j) => (
                                                        <td key={j}>{v}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {msg && (
                <div className={`notice ${msg.cls}`} style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.text}
                </div>
            )}
        </section>
    );
}
