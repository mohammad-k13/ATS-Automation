'use client';
import { useRef, useState } from 'react';
import { api, platformName } from '../lib/api';

export default function TokenButton({
    src,
    onSaved,
    primary,
}: {
    src: string;
    onSaved?: () => void;
    primary?: boolean;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const [val, setVal] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        setErr('');
        try {
            await api(`platforms/${src}/token`, { body: { token: val } });
            ref.current?.close();
            setVal('');
            window.dispatchEvent(new Event('ats:status'));
            onSaved?.();
        } catch (e: any) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <button className={`btn ${primary ? 'primary' : 'ghost sm'}`} onClick={() => ref.current?.showModal()}>
                {primary ? 'به‌روزرسانی توکن' : 'روش دستی: واردکردن توکن'}
            </button>
            <dialog ref={ref} className="modal">
                <div className="panel-pad stack">
                    <h2>توکن {platformName(src)}</h2>
                    <ol className="muted small" style={{ margin: 0, paddingInlineStart: 18 }}>
                        <li>
                            وارد پنل کارفرمایی شوید و <b>F12</b> را بزنید، سپس تب <b>Network</b>.
                        </li>
                        <li>
                            روی یکی از درخواست‌های <span className="ltr">employerapi</span> کلیک کنید ← <b>Headers</b> ←
                            گزینهٔ <b>Raw</b> را روشن کنید.
                        </li>
                        <li>
                            مقدار کامل <span className="ltr">Authorization</span> را کپی و این‌جا وارد کنید.
                        </li>
                    </ol>
                    <textarea
                        className="textarea code"
                        rows={5}
                        value={val}
                        onChange={(e) => setVal(e.target.value)}
                        placeholder="Bearer eyJ..."
                    />
                    {err && <div className="error-text">{err}</div>}
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn ghost" onClick={() => ref.current?.close()}>
                            انصراف
                        </button>
                        <button className="btn primary" disabled={busy || !val.trim()} onClick={save}>
                            ذخیره
                        </button>
                    </div>
                </div>
            </dialog>
        </>
    );
}
