'use client';
import { useEffect, useState } from 'react';
import { api, platformName } from '../lib/api';

/** Jobvision application statuses. */
export const SITE_STATUS_OPTIONS: [number, string][] = [
    [4, 'تایید اولیه'],
    [6, 'در حال بررسی'],
    [5, 'رد شده'],
];
export const SITE_STATUS_LABEL: Record<string, [string, string]> = {
    approved: ['ok', 'تایید اولیه'],
    checking: ['partial', 'در حال بررسی'],
    rejected: ['rej', 'رد شده'],
};

export function SiteStatusBadge({ status, src }: { status?: string | null; src: string }) {
    if (!status || !SITE_STATUS_LABEL[status]) return null;
    const [cls, label] = SITE_STATUS_LABEL[status];
    return (
        <span className={`badge ${cls}`} title={`وضعیت در ${platformName(src)}`}>
            {platformName(src)}: {label}
        </span>
    );
}

export interface StatusMap {
    accepted: number | null;
    partial: number | null;
    rejected: number | null;
    auto: boolean;
}

/** Per-job section: which Jobvision status each result gets. */
export function StatusMapSection({
    src,
    jobId,
    initial,
    onSaved,
}: {
    src: string;
    jobId: string;
    initial: StatusMap;
    onSaved: (m: StatusMap) => void;
}) {
    const [m, setM] = useState<StatusMap>(initial);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
    useEffect(() => setM(initial), [initial]);
    const dirty = JSON.stringify(m) !== JSON.stringify(initial);
    const row = (key: 'accepted' | 'partial' | 'rejected', label: string, cls: string) => (
        <label className="row between" style={{ gap: 12 }}>
            <span className="row">
                <span className={`badge ${cls}`}>{label}</span>
                <span className="faint">←</span>
            </span>
            <select
                className="input"
                style={{ width: 200 }}
                value={m[key] ?? ''}
                onChange={(e) => setM({ ...m, [key]: e.target.value ? Number(e.target.value) : null })}
            >
                {SITE_STATUS_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                        {l}
                    </option>
                ))}
                <option value="">تغییر نده</option>
            </select>
        </label>
    );
    return (
        <section className="panel panel-pad stack">
            <div className="row between">
                <div>
                    <h2>وضعیت در {platformName(src)}</h2>
                    <div className="small muted">
                        نتیجهٔ امتیازدهی هر کارجو در خود {platformName(src)} چه وضعیتی بگیرد.
                    </div>
                </div>
                {dirty && <span className="badge warn">ذخیره‌نشده</span>}
            </div>
            <div className="stack" style={{ gap: 8, maxWidth: 440 }}>
                {row('accepted', 'قبول', 'ok')}
                {row('partial', 'تایید نسبی', 'partial')}
                {row('rejected', 'رد', 'rej')}
            </div>
            <label className="row between">
                <span>
                    <b>اعمال خودکار بعد از هر امتیازدهی</b>
                    <div className="small muted">
                        خاموش باشد، از دکمهٔ «اعمال وضعیت در {platformName(src)}» در تب رزومه‌ها استفاده کنید. ممکن است{' '}
                        {platformName(src)} تغییر وضعیت را به کارجو اطلاع دهد.
                    </div>
                </span>
                <span className="switch">
                    <input type="checkbox" checked={m.auto} onChange={(e) => setM({ ...m, auto: e.target.checked })} />
                    <span />
                </span>
            </label>
            {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
            <div>
                <button
                    className="btn primary sm"
                    disabled={!dirty || busy}
                    onClick={async () => {
                        setBusy(true);
                        setMsg(null);
                        try {
                            const r = await api<StatusMap>(`platforms/${src}/jobs/${jobId}/status-map`, {
                                method: 'PUT',
                                body: m,
                            });
                            onSaved(r);
                            setMsg({ cls: 'ok', text: 'ذخیره شد.' });
                        } catch (e: any) {
                            setMsg({ cls: 'bad', text: e.message });
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    ذخیره
                </button>
            </div>
        </section>
    );
}
