"use client";
import { useState } from "react";
import { useApi } from "../lib/cache";
import { api } from "../lib/api";

interface Integ {
  ai: { provider: string; baseUrl: string; apiKeyMasked: string; hasApiKey: boolean; model: string };
  telegram: { tokenMasked: string; hasToken: boolean; chatId: string; proxy: string };
}
type Msg = { cls: string; text: string } | null;

export default function Integrations({ onChange }: { onChange: () => void }) {
  const q = useApi<Integ>("integrations", { revalidateOnFocus: false });
  const d = q.data;
  const setD = (x: Integ) => q.mutate(x, { revalidate: false });
  if (!d) return <section className="panel panel-pad"><div className="skeleton" style={{ height: 160 }} /></section>;
  return (
    <>
      <AiCard key={JSON.stringify(d.ai)} d={d.ai} onSaved={(x) => { setD(x); onChange(); }} />
      <TelegramCard key={JSON.stringify(d.telegram)} d={d.telegram} onSaved={(x) => { setD(x); onChange(); }} />
    </>
  );
}

function AiCard({ d, onSaved }: { d: Integ["ai"]; onSaved: (x: Integ) => void }) {
  const [enabled, setEnabled] = useState(d.provider !== "keyword");
  const [baseUrl, setBaseUrl] = useState(d.baseUrl || "http://localhost:20128/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(d.model);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const dirty = enabled !== (d.provider !== "keyword") || baseUrl !== d.baseUrl || !!apiKey || model !== d.model;

  const fetchModels = async () => {
    setBusy("models"); setMsg(null);
    try {
      const list = await api<string[]>("integrations/ai/models", { body: { baseUrl, apiKey } });
      setModels(list);
      if (!list.length) setMsg({ cls: "", text: "OmniRoute مدلی برنگرداند؛ نام مدل را دستی وارد کنید." });
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };
  const save = async () => {
    setBusy("save"); setMsg(null);
    try {
      const x = await api<Integ>("integrations/ai", { method: "PUT", body: { enabled, baseUrl, apiKey: apiKey || undefined, model } });
      setApiKey("");
      onSaved(x);
      window.dispatchEvent(new Event("ats:status"));
      setMsg({ cls: "ok", text: "ذخیره شد." });
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };
  const test = async () => {
    setBusy("test"); setMsg(null);
    try {
      const r = await api<{ answer: string; ms: number; model: string }>("integrations/ai/test", { body: {} });
      setMsg({ cls: "ok", text: `اتصال برقرار است (${r.model}، ${Math.round(r.ms / 100) / 10} ثانیه):\n«${r.answer}»` });
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };

  return (
    <section className="panel panel-pad stack">
      <div className="row between">
        <div>
          <h2>هوش مصنوعی (OmniRoute)</h2>
          <div className="small muted">برای امتیازدهی رزومه‌ها، ساخت شرایط آگهی و دستیار استخدام</div>
        </div>
        <label className="row small" style={{ cursor: "pointer" }}>
          {enabled ? "فعال" : "غیرفعال"}
          <span className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span /></span>
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>آدرس (Base URL)</span>
          <input className="input ltr" style={{ textAlign: "left" }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:20128/v1" />
        </label>
        <label className="field">
          <span>کلید API</span>
          <input className="input ltr" style={{ textAlign: "left" }} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={d.hasApiKey ? `ذخیره شده (${d.apiKeyMasked}) — برای تغییر وارد کنید` : "sk-..."} autoComplete="off" />
        </label>
      </div>
      <label className="field">
        <span>مدل</span>
        <div className="row">
          {models.length ? (
            <select className="input ltr" style={{ textAlign: "left" }} value={model} onChange={(e) => setModel(e.target.value)}>
              {!models.includes(model) && <option value={model}>{model || "— انتخاب مدل —"}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input className="input ltr" style={{ textAlign: "left" }} value={model} onChange={(e) => setModel(e.target.value)} placeholder="مثلاً cc/claude-sonnet-4-6" />
          )}
          <button className="btn" disabled={busy !== "" || !baseUrl} onClick={fetchModels}>{busy === "models" ? "در حال دریافت…" : "دریافت فهرست مدل‌ها"}</button>
        </div>
        <small>برای رزومه‌های فارسی، مدلی انتخاب کنید که فارسی را خوب می‌فهمد.{models.length > 0 && ` (${models.length.toLocaleString("fa-IR")} مدل)`}</small>
      </label>
      {msg && <div className={`notice ${msg.cls}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy !== "" || !dirty} onClick={save}>{busy === "save" ? "در حال ذخیره…" : "ذخیره"}</button>
        <button className="btn" disabled={busy !== "" || dirty || !enabled} onClick={test} title={dirty ? "اول ذخیره کنید" : ""}>{busy === "test" ? "در حال آزمایش…" : "آزمایش اتصال"}</button>
      </div>
    </section>
  );
}

function TelegramCard({ d, onSaved }: { d: Integ["telegram"]; onSaved: (x: Integ) => void }) {
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(d.chatId);
  const [proxy, setProxy] = useState(d.proxy);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const dirty = !!token || chatId !== d.chatId || proxy !== d.proxy;

  const save = async () => {
    setBusy("save"); setMsg(null);
    try {
      const x = await api<Integ>("integrations/telegram", { method: "PUT", body: { token: token || undefined, chatId, proxy } });
      setToken(""); onSaved(x);
      setMsg({ cls: "ok", text: "ذخیره شد." });
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };
  const test = async () => {
    setBusy("test"); setMsg(null);
    try { await api("integrations/telegram/test", { body: {} }); setMsg({ cls: "ok", text: "پیام آزمایشی به تلگرام ارسال شد." }); }
    catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };

  return (
    <section className="panel panel-pad stack">
      <div>
        <h2>تلگرام</h2>
        <div className="small muted">رزومه‌های قبول‌شده در اجرای خودکار به این چت فرستاده می‌شوند</div>
      </div>
      <div className="grid2">
        <label className="field">
          <span>توکن ربات</span>
          <input className="input ltr" style={{ textAlign: "left" }} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off"
            placeholder={d.hasToken ? `ذخیره شده (${d.tokenMasked}) — برای تغییر وارد کنید` : "123456789:ABC..."} />
          <small>از ربات <span className="ltr">@BotFather</span> در تلگرام بگیرید</small>
        </label>
        <label className="field">
          <span>شناسهٔ چت یا گروه</span>
          <input className="input ltr" style={{ textAlign: "left" }} value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
          <small>ربات را به گروه اضافه کنید؛ شناسه را می‌توانید از <span className="ltr">@userinfobot</span> بگیرید</small>
        </label>
      </div>
      <label className="field">
        <span>پراکسی (اختیاری)</span>
        <input className="input ltr" style={{ textAlign: "left" }} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http://127.0.0.1:10809" />
        <small>اگر تلگرام روی این سیستم فیلتر است، آدرس پراکسی HTTP را وارد کنید</small>
      </label>
      {msg && <div className={`notice ${msg.cls}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy !== "" || !dirty} onClick={save}>{busy === "save" ? "در حال ذخیره…" : "ذخیره"}</button>
        <button className="btn" disabled={busy !== "" || dirty || !d.hasToken || !d.chatId} onClick={test}>{busy === "test" ? "در حال ارسال…" : "ارسال پیام آزمایشی"}</button>
      </div>
    </section>
  );
}
