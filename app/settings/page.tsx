"use client";
import { useEffect, useRef, useState } from "react";
import { tokenState } from "../components/Sidebar";
import AutoLogin from "../components/AutoLogin";
import GoogleSheet from "../components/GoogleSheet";
import Integrations from "../components/Integrations";
import { api, platformName, type Status } from "../lib/api";
import { refresh, useApi } from "../lib/cache";

export default function SettingsPage() {
  const { data: st } = useApi<Status>("status");
  const srcQ = useApi<{ file: string; text: string; exists: boolean }>("sources", { revalidateOnFocus: false });
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const orig = srcQ.data?.text ?? "";
  const file = srcQ.data?.file ?? "";
  const exists = srcQ.data?.exists ?? true;
  const edited = useRef(false);
  useEffect(() => { if (srcQ.data && !edited.current) setText(srcQ.data.text); }, [srcQ.data]);
  const loadStatus = () => refresh("status");

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ file: string; text: string; exists: boolean }>("sources", { method: "PUT", body: { text } });
      await srcQ.mutate(r, { revalidate: false }); edited.current = false;
      refresh("platforms/", true);
      setMsg({ cls: "ok", text: "ذخیره شد." });
      loadStatus();
      window.dispatchEvent(new Event("ats:status"));
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>تنظیمات</h1><p>اتصال به پلتفرم‌ها، هوش مصنوعی، تلگرام و منابع رزومه</p></div>
      </div>
      <div className="stack" style={{ gap: 18 }}>
        <section className="panel panel-pad stack">
          <h2>پلتفرم‌ها</h2>
          {st?.sourcesError && <div className="notice bad">{st.sourcesError}</div>}
          {!st && <div className="skeleton" style={{ height: 120 }} />}
          {st?.platforms.map((p) => {
            const ts = tokenState(p.token);
            return (
              <div key={p.name} className="stack" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 16, gap: 12 }}>
                <div className="row between">
                  <h3>{platformName(p.name)}</h3>
                  <div className="small muted row"><span className={`dot ${ts.cls}`} /> اتصال: {p.token.valid ? `برقرار (${ts.label} تا انقضای توکن)` : ts.label}</div>
                </div>
                {p.type === "jobvision" && <AutoLogin p={p} onChange={loadStatus} />}
              </div>
            );
          })}
        </section>

        <Integrations onChange={loadStatus} />

        <GoogleSheet />

        <section className="panel panel-pad stack">
          <div className="section-title">
            <div>
              <h2>فایل منابع <span className="ltr faint small">{file}</span></h2>
              <div className="small muted">تنظیمات هر پلتفرم: فعال بودن، فاصلهٔ بین درخواست‌ها (<span className="ltr">delayMs</span>)، حداکثر رزومه در هر آگهی (<span className="ltr">maxPerJob</span>)، آگهی‌های بررسی خودکار (<span className="ltr">jobPostIds</span>). توکن را این‌جا ننویسید.</div>
            </div>
            {text !== orig && <span className="badge warn">ذخیره‌نشده</span>}
          </div>
          {!exists && <div className="notice">فایل هنوز ساخته نشده؛ این محتوای نمونه است. با ذخیره ساخته می‌شود.</div>}
          {!srcQ.data && <div className="skeleton" style={{ height: 300 }} />}
          {srcQ.data && <textarea className="textarea code" rows={22} value={text} onChange={(e) => { edited.current = true; setText(e.target.value); }} spellCheck={false} />}
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
