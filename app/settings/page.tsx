"use client";
import { useEffect, useState } from "react";
import { tokenState } from "../components/Sidebar";
import TokenButton from "../components/TokenDialog";
import { api, platformName, type Status } from "../lib/api";

export default function SettingsPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [file, setFile] = useState("");
  const [exists, setExists] = useState(true);
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = () => api<Status>("status").then(setSt).catch(() => {});
  useEffect(() => {
    loadStatus();
    api<{ file: string; text: string; exists: boolean }>("sources").then((r) => { setText(r.text); setOrig(r.text); setFile(r.file); setExists(r.exists); });
  }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ text: string }>("sources", { method: "PUT", body: { text } });
      setOrig(r.text); setExists(true);
      setMsg({ cls: "ok", text: "ذخیره شد." });
      loadStatus();
      window.dispatchEvent(new Event("ats:status"));
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>منابع و توکن‌ها</h1><p>اتصال به پلتفرم‌ها و تنظیمات کلی دریافت رزومه</p></div>
      </div>
      <div className="stack" style={{ gap: 18 }}>
        <section className="panel panel-pad stack">
          <h2>پلتفرم‌ها</h2>
          {st?.sourcesError && <div className="notice bad">{st.sourcesError}</div>}
          {st?.platforms.map((p) => {
            const ts = tokenState(p.token);
            return (
              <div key={p.name} className="row between" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 12 }}>
                <div>
                  <h3>{platformName(p.name)}</h3>
                  <div className="small muted row"><span className={`dot ${ts.cls}`} /> توکن: {ts.label}{p.token.valid && " باقی‌مانده"}</div>
                </div>
                {p.type === "jobvision" && <TokenButton src={p.name} onSaved={loadStatus} primary={!p.token.valid} />}
              </div>
            );
          })}
          <div className="row between">
            <div>
              <h3>هوش مصنوعی</h3>
              <div className="small muted">{st?.ai.provider === "keyword" ? "تنظیم نشده — فقط امتیازدهی کلمه‌کلیدی" : <span className="ltr">{st?.ai.provider} · {st?.ai.model}</span>}</div>
            </div>
            <span className="small faint">در فایل <span className="ltr">.env</span></span>
          </div>
          <div className="row between">
            <div>
              <h3>تلگرام</h3>
              <div className="small muted">{st?.telegram ? "متصل" : "تنظیم نشده"}</div>
            </div>
            <span className="small faint">در فایل <span className="ltr">.env</span></span>
          </div>
        </section>

        <section className="panel panel-pad stack">
          <div className="section-title">
            <div>
              <h2>فایل منابع <span className="ltr faint small">{file}</span></h2>
              <div className="small muted">تنظیمات هر پلتفرم: فعال بودن، فاصلهٔ بین درخواست‌ها (<span className="ltr">delayMs</span>)، حداکثر رزومه در هر آگهی (<span className="ltr">maxPerJob</span>)، آگهی‌های بررسی خودکار (<span className="ltr">jobPostIds</span>). توکن را این‌جا ننویسید.</div>
            </div>
            {text !== orig && <span className="badge warn">ذخیره‌نشده</span>}
          </div>
          {!exists && <div className="notice">فایل هنوز ساخته نشده؛ این محتوای نمونه است. با ذخیره ساخته می‌شود.</div>}
          <textarea className="textarea code" rows={22} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          {msg && <div className={`notice ${msg.cls}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || (text === orig && exists)} onClick={save}>ذخیره</button>
            <button className="btn ghost" disabled={text === orig} onClick={() => setText(orig)}>بازگردانی</button>
          </div>
        </section>
      </div>
    </>
  );
}
