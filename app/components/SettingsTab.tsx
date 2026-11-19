'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { isFilterKeyword } from '@/core/ats/domain/keywords';
import { api, fa, platformName } from '../lib/api';
import { StatusMapSection, type StatusMap } from './SiteStatus';
import TagsInput from './TagsInput';
import { useApi } from '../lib/cache';

interface Criteria {
  threshold: number;
  partialThreshold?: number | null;
  mustHave: string[];
  niceToHave: string[];
  hardFilters: { minYears: number | null; requireAny: string[]; rejectIfAny: string[] };
  instructions: string;
}
interface Settings {
  criteria: Criteria | null;
  criteriaKind: string;
  criteriaName: string | null;
  scheduled: boolean;
  sourceStatus: number;
  unit: string;
  description: string;
  adText: string;
  adFetchedAt: string | null;
  statusMap: StatusMap;
}

const EMPTY: Criteria = {
  threshold: 70,
  partialThreshold: 50,
  mustHave: [],
  niceToHave: [],
  hardFilters: { minYears: null, requireAny: [], rejectIfAny: [] },
  instructions: '',
};

const partialOf = (c: Criteria) =>
  Math.min(c.partialThreshold ?? Math.max(0, c.threshold - 20), c.threshold);

export default function SettingsTab({
  src,
  jobId,
  jobTitle,
  onSaved,
  scoringRunning,
  onRestartScoring,
}: {
  src: string;
  jobId: string;
  jobTitle: string;
  onSaved: () => void;
  scoringRunning?: boolean;
  onRestartScoring?: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [savedWhileRunning, setSavedWhileRunning] = useState(false);
  const key = `platforms/${src}/jobs/${jobId}/settings`;
  const q = useApi<Settings>(key);
  const s = q.data ?? null;
  const setS = (fn: (o: Settings | null) => Settings | null) =>
    q.mutate((o) => fn(o ?? null) ?? undefined, { revalidate: false });
  const [c, setC] = useState<Criteria>(EMPTY);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState<'' | 'draft' | 'save'>('');
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  // fill the form from the (cached, then fresh) settings as long as the user has not started editing
  const touched = useRef(false);
  useEffect(() => {
    if (!q.data || touched.current) return;
    setC(q.data.criteria ?? EMPTY);
    setDesc(q.data.description ?? '');
  }, [q.data]);
  useEffect(() => {
    if (q.error) setMsg({ cls: 'bad', text: q.error.message });
  }, [q.error]);

  const longFilters = [
    ...(c.hardFilters.requireAny ?? []),
    ...(c.hardFilters.rejectIfAny ?? []),
  ].filter((x) => !isFilterKeyword(x));

  const upd = (patch: Partial<Criteria>) => {
    touched.current = true;
    setC((o) => ({ ...o, ...patch }));
    setDirty(true);
  };
  const updHF = (patch: Partial<Criteria['hardFilters']>) => {
    touched.current = true;
    setC((o) => ({ ...o, hardFilters: { ...o.hardFilters, ...patch } }));
    setDirty(true);
  };

  const draft = async () => {
    setBusy('draft');
    setMsg(null);
    try {
      const d = await api<Criteria>(`platforms/${src}/jobs/${jobId}/criteria/draft`, {
        body: { jobTitle, description: desc, current: s?.criteriaKind === 'job' ? c : null },
      });
      setC({ ...EMPTY, ...d, hardFilters: { ...EMPTY.hardFilters, ...d.hardFilters } });
      setS((o) => (o ? { ...o, description: desc } : o));
      setDirty(true);
      setMsg({
        cls: '',
        text: 'پیش‌نویس شرایط آماده شد. بررسی و در صورت نیاز ویرایش کنید، سپس «ذخیره» را بزنید.',
      });
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const [adBusy, setAdBusy] = useState(false);
  const [showAd, setShowAd] = useState(false);
  const descDirty = !!s && desc !== (s.description ?? '');
  const saveDesc = async () => {
    try {
      await api(`platforms/${src}/jobs/${jobId}/description`, {
        method: 'PUT',
        body: { description: desc },
      });
      setS((o) => (o ? { ...o, description: desc } : o));
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    }
  };
  const fetchAd = async () => {
    setAdBusy(true);
    setMsg(null);
    try {
      const r = await api<{ adText: string; adFetchedAt: string }>(
        `platforms/${src}/jobs/${jobId}/ad`,
        { body: {} },
      );
      setS((o) => (o ? { ...o, adText: r.adText, adFetchedAt: r.adFetchedAt } : o));
      setShowAd(true);
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    } finally {
      setAdBusy(false);
    }
  };

  const save = async () => {
    if (descDirty) await saveDesc();
    setBusy('save');
    setMsg(null);
    try {
      const x = await api<Settings>(`platforms/${src}/jobs/${jobId}/criteria`, {
        method: 'PUT',
        body: { criteria: c, jobTitle },
      });
      await q.mutate(x, { revalidate: false });
      setDirty(false);
      touched.current = false;
      setSavedWhileRunning(!!scoringRunning);
      setMsg({
        cls: 'ok',
        text: scoringRunning
          ? 'ذخیره شد. امتیازدهیِ در حال اجرا هنوز با شرایط قبلی ادامه دارد.'
          : 'ذخیره شد. برای اعمال شرایط جدید روی رزومه‌های قبلی، در تب رزومه‌ها «امتیازدهی مجدد همه» را بزنید.',
      });
      onSaved();
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    } finally {
      setBusy('');
    }
  };

  const [unit, setUnit] = useState<string | null>(null);
  const saveUnit = async () => {
    try {
      await api(`platforms/${src}/jobs/${jobId}/unit`, { method: 'PUT', body: { unit } });
      setS((o) => (o ? { ...o, unit: unit ?? '' } : o));
      setUnit(null);
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    }
  };

  const toggleScheduled = async (on: boolean) => {
    try {
      await q.mutate(
        await api<Settings>(`platforms/${src}/jobs/${jobId}/scheduled`, {
          method: 'PUT',
          body: { on },
        }),
        { revalidate: false },
      );
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    }
  };

  if (!s) return <div className="empty">در حال بارگذاری…</div>;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <section className="panel panel-pad stack">
        <div className="section-title">
          <div>
            <h2>شرایط آگهی</h2>
            <div className="small muted">
              {s.criteriaKind === 'job'
                ? 'شرایط اختصاصی این آگهی'
                : s.criteriaKind === 'default'
                  ? 'هنوز شرایط اختصاصی ندارد؛ از شرایط عمومی استفاده می‌شود'
                  : s.criteriaKind === 'none'
                    ? 'هنوز شرایطی تعریف نشده'
                    : `از فایل ${s.criteriaName}`}
            </div>
          </div>
          {(dirty || descDirty) && <span className="badge warn">ذخیره‌نشده</span>}
        </div>

        <div className="field">
          <div className="row between">
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              متن آگهی منتشرشده در {platformName(src)}
            </span>
            <button className="btn sm ghost" disabled={adBusy} onClick={fetchAd}>
              {adBusy ? 'در حال دریافت…' : s.adText ? '↻ دریافت دوباره' : 'دریافت متن آگهی'}
            </button>
          </div>
          {s.adText ? (
            <div
              className="resume-text"
              style={{
                maxHeight: showAd ? 420 : 110,
                overflow: showAd ? 'auto' : 'hidden',
                cursor: showAd ? 'auto' : 'pointer',
              }}
              onClick={() => setShowAd(true)}
            >
              {s.adText}
            </div>
          ) : (
            <small className="muted">
              متن آگهی هنوز دریافت نشده. اگر دریافت نشد، کافی است شغل را در کادر زیر توضیح دهید.
            </small>
          )}
        </div>

        <label className="field">
          <span>توضیحات شما دربارهٔ این شغل</span>
          <small>
            هر چیزی که در آگهی نیست یا برایتان مهم‌تر است را بنویسید. این متن ذخیره می‌شود و هوش
            مصنوعی در امتیازدهی و گفتگو از آن استفاده می‌کند؛ لازم نیست دوباره توضیح دهید.
          </small>
          <textarea
            className="textarea"
            rows={4}
            value={desc}
            onChange={(e) => {
              touched.current = true;
              setDesc(e.target.value);
            }}
            placeholder="مثلاً: کسی را می‌خواهیم که خودش مدیریت خط تولید را انجام داده باشد، نه فقط کار دفتری. ساکن اصفهان یا نجف‌آباد باشد بهتر است…"
          />
        </label>
        <div className="row wrap">
          <button
            className="btn"
            disabled={(!desc.trim() && !s.adText) || busy !== ''}
            onClick={draft}
          >
            {busy === 'draft'
              ? 'در حال ساخت…'
              : desc.trim() || !s.adText
                ? 'ساخت شرایط با هوش مصنوعی'
                : 'ساخت شرایط از روی متن آگهی'}
          </button>
          {descDirty && (
            <button className="btn ghost" onClick={saveDesc}>
              ذخیرهٔ توضیحات
            </button>
          )}
        </div>

        <hr
          style={{ border: 0, borderTop: '1px solid var(--line)', width: '100%', margin: '4px 0' }}
        />

        <label className="field">
          <span>مهارت‌ها و تجربه‌های الزامی</span>
          <small>هر مورد را بنویسید و Enter بزنید</small>
          <TagsInput
            value={c.mustHave}
            onChange={(v) => upd({ mustHave: v })}
            placeholder="مثلاً مدیریت تولید"
          />
        </label>
        <label className="field">
          <span>امتیاز اضافه (اختیاری)</span>
          <TagsInput
            value={c.niceToHave}
            onChange={(v) => upd({ niceToHave: v })}
            placeholder="مثلاً ERP"
          />
        </label>
        <div className="grid2">
          <div className="field">
            <span style={{ fontWeight: 600, fontSize: 13 }}>
              قبول از <b style={{ color: 'var(--ok)' }}>{fa(c.threshold)}</b> · تایید نسبی از{' '}
              <b style={{ color: 'var(--warn)' }}>{fa(partialOf(c))}</b> · کمتر از آن رد
            </span>
            <label className="row small">
              <span style={{ width: 92 }}>حداقل قبولی</span>
              <input
                type="range"
                className="grow"
                min={0}
                max={100}
                step={5}
                value={c.threshold}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  upd({ threshold: t, partialThreshold: Math.min(partialOf(c), t) });
                }}
              />
            </label>
            <label className="row small">
              <span style={{ width: 92 }}>حداقل تایید نسبی</span>
              <input
                type="range"
                className="grow partial-range"
                min={0}
                max={100}
                step={5}
                value={partialOf(c)}
                onChange={(e) =>
                  upd({ partialThreshold: Math.min(Number(e.target.value), c.threshold) })
                }
              />
            </label>
            <small className="muted">
              امتیاز بین این دو عدد «تایید نسبی» است. برای حذف این وضعیت، هر دو را برابر بگذارید.
            </small>
          </div>
          <label className="field">
            <span>حداقل سابقهٔ کار (سال)</span>
            <input
              className="input"
              type="number"
              min={0}
              value={c.hardFilters.minYears ?? ''}
              placeholder="بدون محدودیت"
              onChange={(e) =>
                updHF({ minYears: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>حتماً یکی از این‌ها را داشته باشد</span>
            <small>
              کلمهٔ کوتاه، نه جمله (مثلاً «نگهبانی»، «انتظامات»). این‌ها عیناً در متن رزومه جستجو
              می‌شوند.
            </small>
            <TagsInput
              value={c.hardFilters.requireAny}
              onChange={(v) => updHF({ requireAny: v })}
              placeholder="اختیاری"
            />
          </label>
          <label className="field">
            <span>اگر این‌ها را داشت رد شود</span>
            <small>کلمهٔ کوتاه، نه جمله.</small>
            <TagsInput
              value={c.hardFilters.rejectIfAny}
              onChange={(v) => updHF({ rejectIfAny: v })}
              placeholder="اختیاری"
            />
          </label>
        </div>
        {longFilters.length > 0 && (
          <div className="notice">
            این عبارت‌ها جمله هستند و نمی‌توانند شرط قطعی باشند؛ هنگام ذخیره به «توضیحات برای هوش
            مصنوعی» منتقل می‌شوند تا هوش مصنوعی خودش قضاوت کند:
            <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
              {longFilters.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        <label className="field">
          <span>توضیحات برای هوش مصنوعی</span>
          <small>اولویت‌ها، چیزهایی که مهم است و چیزهایی که امتیاز را کم می‌کند</small>
          <textarea
            className="textarea"
            rows={5}
            value={c.instructions}
            onChange={(e) => upd({ instructions: e.target.value })}
          />
        </label>

        {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
        {savedWhileRunning && scoringRunning && onRestartScoring && (
          <div className="row">
            <button
              className="btn primary"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                try {
                  await onRestartScoring();
                  setSavedWhileRunning(false);
                  setMsg({ cls: 'ok', text: 'امتیازدهی با شرایط جدید از نو شروع شد.' });
                } catch (e: any) {
                  setMsg({ cls: 'bad', text: e.message });
                } finally {
                  setRestarting(false);
                }
              }}
            >
              {restarting ? 'در حال توقف و شروع دوباره…' : 'توقف و امتیازدهی مجدد با شرایط جدید'}
            </button>
          </div>
        )}
        <div className="row">
          <button
            className="btn primary"
            disabled={busy !== '' || (!dirty && !descDirty && s.criteriaKind === 'job')}
            onClick={save}
          >
            {busy === 'save' ? 'در حال ذخیره…' : 'ذخیره شرایط'}
          </button>
        </div>
      </section>

      <StatusMapSection
        src={src}
        jobId={jobId}
        initial={s.statusMap ?? { accepted: 4, partial: 6, rejected: 5, auto: false }}
        onSaved={(m) => setS((o) => (o ? { ...o, statusMap: m } : o))}
      />

      <section className="panel panel-pad stack">
        <h2>اطلاعات آگهی</h2>
        <label className="field">
          <span>نام واحد</span>
          <small>در گزارش‌ها نمایش داده می‌شود (مثلاً تولید، مالی، فروش)</small>
          <div className="row">
            <input
              className="input"
              value={unit ?? s.unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="مثلاً واحد تولید"
            />
            <button className="btn" disabled={unit === null || unit === s.unit} onClick={saveUnit}>
              ذخیره
            </button>
          </div>
        </label>
      </section>

      <section className="panel panel-pad stack">
        <h2>تنظیمات منبع</h2>
        <div className="row between">
          <div>
            <h3>بررسی خودکار</h3>
            <div className="small muted">
              اگر فعال باشد، اجرای زمان‌بندی‌شده (<span className="ltr">npm run schedule</span>)
              رزومه‌های جدید این آگهی را هم بررسی می‌کند و قبولی‌ها را به تلگرام می‌فرستد.
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={s.scheduled}
              onChange={(e) => toggleScheduled(e.target.checked)}
            />
            <span />
          </label>
        </div>
        <div className="small muted">
          فقط رزومه‌هایی که در {platformName(src)} هنوز «تعیین وضعیت نشده» هستند دریافت می‌شوند
          (وضعیت {fa(s.sourceStatus)}). سایر تنظیمات منبع در صفحهٔ{' '}
          <Link href="/settings" style={{ color: 'var(--accent)' }}>
            منابع و توکن‌ها
          </Link>{' '}
          است.
        </div>
      </section>
    </div>
  );
}
