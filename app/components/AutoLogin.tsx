'use client';
import { useState } from 'react';
import { api, type Status } from '../lib/api';
import { refresh } from '../lib/cache';
import RemoteLogin from './RemoteLogin';
import TokenButton from './TokenDialog';

type P = Status['platforms'][number];

export default function AutoLogin({ p, onChange }: { p: P; onChange: () => void }) {
      const [email, setEmail] = useState(p.autoLogin.email);
      const [password, setPassword] = useState('');
      const [show, setShow] = useState(false);
      const [busy, setBusy] = useState<'' | 'save' | 'login'>('');
      const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);

      const saveAndLogin = async () => {
            setMsg(null);
            try {
                  setBusy('save');
                  if (email !== p.autoLogin.email || password)
                        await api(`platforms/${p.name}/credentials`, {
                              method: 'PUT',
                              body: { email, password },
                        });
                  setPassword('');
                  setBusy('login');
                  await api(`platforms/${p.name}/login`, { body: { show } });
                  setMsg({
                        cls: 'ok',
                        text: 'ورود موفق بود و توکن جدید ذخیره شد. از این به بعد هر وقت توکن منقضی شود، سامانه خودش دوباره وارد می‌شود.',
                  });
                  window.dispatchEvent(new Event('ats:status'));
                  refresh('platforms/', true);
                  onChange();
            } catch (e: any) {
                  setMsg({ cls: 'bad', text: e.message });
                  onChange();
            } finally {
                  setBusy('');
            }
      };

      const canSubmit = email.trim() && (password || p.autoLogin.hasPassword) && !busy;
      return (
            <div className="stack" style={{ gap: 10 }}>
                  <div className="grid2">
                        <label className="field">
                              <span>ایمیل یا نام کاربری</span>
                              <input
                                    className="input ltr"
                                    style={{ textAlign: 'left' }}
                                    type="email"
                                    autoComplete="username"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@company.com"
                              />
                        </label>
                        <label className="field">
                              <span>رمز عبور</span>
                              <input
                                    className="input ltr"
                                    style={{ textAlign: 'left' }}
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder={
                                          p.autoLogin.hasPassword
                                                ? 'ذخیره شده — برای تغییر وارد کنید'
                                                : ''
                                    }
                              />
                        </label>
                  </div>
                  <div className="row wrap">
                        <button
                              className="btn primary"
                              disabled={!canSubmit}
                              onClick={saveAndLogin}
                        >
                              {busy === 'save'
                                    ? 'در حال ذخیره…'
                                    : busy === 'login'
                                      ? 'در حال ورود به سایت…'
                                      : 'ذخیره و ورود'}
                        </button>
                        <label className="row small muted" style={{ cursor: 'pointer' }}>
                              <input
                                    type="checkbox"
                                    checked={show}
                                    onChange={(e) => setShow(e.target.checked)}
                              />{' '}
                              نمایش مرورگر (اگر کپچا یا کد پیامکی دارد)
                        </label>
                        <span className="grow" />
                        <TokenButton src={p.name} onSaved={onChange} />
                  </div>
                  {busy === 'login' && (
                        <div className="small muted">
                              مرورگر در پس‌زمینه وارد سایت می‌شود؛ معمولاً ۱۰ تا ۳۰ ثانیه طول می‌کشد.
                        </div>
                  )}
                  {msg && (
                        <div className={`notice ${msg.cls}`} style={{ whiteSpace: 'pre-wrap' }}>
                              {msg.text}
                        </div>
                  )}
                  {msg?.text.includes('تصویر صفحه') && (
                        <a
                              href={`/api/debug/login-shot?t=${Date.now()}`}
                              target="_blank"
                              rel="noreferrer"
                        >
                              <img
                                    src={`/api/debug/login-shot?t=${Date.now()}`}
                                    alt="تصویر صفحهٔ ورود"
                                    style={{
                                          maxWidth: '100%',
                                          border: '1px solid var(--border)',
                                          borderRadius: 8,
                                    }}
                              />
                        </a>
                  )}
                  <RemoteLogin src={p.name} onDone={onChange} />
                  <a
                        className="small"
                        href="/api/debug/login-shot"
                        target="_blank"
                        rel="noreferrer"
                  >
                        آخرین تصویر خطای ورود
                  </a>
                  <AttachmentFix src={p.name} />
                  <div className="small faint">
                        ایمیل و رمز فقط روی همین کامپیوتر در فایل <span className="ltr">.env</span>{' '}
                        ذخیره می‌شوند و برای ورود خودکار هر چند ساعت یک بار استفاده می‌شوند.
                  </div>
            </div>
      );
}

/** Runs the server-side check that finds out how attached resumes download (fixes the 401). */
function AttachmentFix({ src }: { src: string }) {
      const [busy, setBusy] = useState(false);
      const [out, setOut] = useState<{ fixed: boolean; report: string } | null>(null);
      const [err, setErr] = useState('');
      const run = async () => {
            setBusy(true);
            setErr('');
            setOut(null);
            try {
                  setOut(await api(`platforms/${src}/diagnose/attachment`, { body: {} }));
            } catch (e: any) {
                  setErr(e.message);
            } finally {
                  setBusy(false);
            }
      };
      return (
            <div
                  className="stack"
                  style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}
            >
                  <div className="row wrap">
                        <button className="btn sm" disabled={busy} onClick={run}>
                              {busy ? 'در حال بررسی… (تا ۱ دقیقه)' : 'رفع خطای دانلود فایل پیوست'}
                        </button>
                        <span className="small faint">
                              سامانه در یک مرورگر مخفی وارد پنل می‌شود، فایل پیوست یک کارجو را باز
                              می‌کند و روش درست دانلود را یاد می‌گیرد.
                        </span>
                  </div>
                  {err && (
                        <div className="notice bad" style={{ whiteSpace: 'pre-wrap' }}>
                              {err}
                        </div>
                  )}
                  {out && (
                        <>
                              <div className={`notice ${out.fixed ? 'ok' : 'warn'}`}>
                                    {out.fixed
                                          ? 'درست شد ✔ از این به بعد فایل‌های پیوست دانلود می‌شوند.'
                                          : 'هنوز درست نشده. گزارش زیر را کپی کنید و بفرستید (رمز یا توکنی در آن نیست).'}
                              </div>
                              <textarea
                                    className="input ltr"
                                    readOnly
                                    rows={10}
                                    value={out.report}
                                    style={{
                                          fontFamily: 'monospace',
                                          fontSize: 12,
                                          textAlign: 'left',
                                    }}
                              />
                              <button
                                    className="btn sm ghost"
                                    onClick={() => navigator.clipboard?.writeText(out.report)}
                              >
                                    کپی گزارش
                              </button>
                        </>
                  )}
            </div>
      );
}
