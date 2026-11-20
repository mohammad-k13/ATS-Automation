'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { refresh } from '../lib/cache';

/**
 * Log in to Jobvision by hand when its login page has a captcha: the server's browser is shown here as
 * a picture; clicks and typing are sent to it. Afterwards the token renews itself without a captcha.
 */
export default function RemoteLogin({ src, onDone }: { src: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const poll = async () => {
    try {
      const st = await api<{ open: boolean; done: boolean; error: string | null }>(
        `platforms/${src}/remote-login`,
      );
      if (st.done) {
        stop();
        setOpen(false);
        setMsg(
          st.error
            ? { cls: 'bad', text: st.error }
            : {
                cls: 'ok',
                text: 'ورود موفق ✔ توکن ذخیره شد. از این به بعد توکن خودش تمدید می‌شود (بدون کپچا).',
              },
        );
        window.dispatchEvent(new Event('ats:status'));
        refresh('platforms/', true);
        onDone();
      } else if (!st.open) {
        stop();
        setOpen(false);
        setMsg({ cls: 'warn', text: 'پنجرهٔ ورود بسته شد (بیش از ۱۰ دقیقه بدون استفاده).' });
      } else setTick((t) => t + 1);
    } catch {
      /* keep polling */
    }
  };

  const start = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api(`platforms/${src}/remote-login`, { body: {} });
      setOpen(true);
      setTick((t) => t + 1);
      stop();
      timer.current = setInterval(poll, 1200);
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    stop();
    setOpen(false);
    await api(`platforms/${src}/remote-login`, { method: 'DELETE' }).catch(() => {});
  };
  const send = async (path: string, body: unknown) => {
    try {
      await api(`platforms/${src}/remote-login/${path}`, { body });
      setTimeout(() => setTick((t) => t + 1), 300);
    } catch (e: any) {
      setMsg({ cls: 'bad', text: e.message });
    }
  };
  const onImgClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void send('click', { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const sendText = async () => {
    if (!text) return;
    await send('type', { text });
    setText('');
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {!open && (
        <div className="row wrap">
          <button className="btn sm" disabled={busy} onClick={start}>
            {busy ? 'در حال باز کردن…' : 'ورود دستی (اگر کپچا دارد)'}
          </button>
          <span className="small faint">
            صفحهٔ ورود جاب‌ویژن همین‌جا باز می‌شود؛ کپچا را خودتان وارد می‌کنید. فقط یک بار لازم
            است.
          </span>
        </div>
      )}
      {open && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="small muted">
            روی تصویر کلیک کنید تا آن قسمت انتخاب شود، بعد متن را در کادر زیر بنویسید و «ارسال»
            بزنید (ایمیل از قبل پر شده). کپچا ← ادامه ← رمز ← ورود.
          </div>
          <img
            src={`/api/platforms/${src}/remote-login/shot?t=${tick}`}
            alt="صفحهٔ ورود جاب‌ویژن"
            onClick={onImgClick}
            style={{
              width: '100%',
              maxWidth: 1000,
              cursor: 'crosshair',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          />
          <div className="row wrap">
            <input
              className="input ltr grow"
              style={{ textAlign: 'left', minWidth: 180 }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), sendText())}
              placeholder="متن (کپچا یا رمز)"
              autoComplete="off"
            />
            <button className="btn sm primary" onClick={sendText}>
              ارسال
            </button>
            <button className="btn sm" onClick={() => send('key', { key: 'Enter' })}>
              Enter
            </button>
            <button className="btn sm" onClick={() => send('key', { key: 'Backspace' })}>
              ⌫
            </button>
            <button className="btn sm" onClick={() => send('key', { key: 'Tab' })}>
              Tab
            </button>
            <button className="btn sm ghost" onClick={() => setTick((t) => t + 1)}>
              تازه‌سازی تصویر
            </button>
            <button className="btn sm ghost" onClick={cancel}>
              بستن
            </button>
          </div>
        </div>
      )}
      {msg && (
        <div className={`notice ${msg.cls}`} style={{ whiteSpace: 'pre-wrap' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
