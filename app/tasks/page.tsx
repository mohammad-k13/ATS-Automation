"use client";
import { useState } from "react";
import { api, fa, faDate, type Status } from "../lib/api";
import { mutate, useApi } from "../lib/cache";

interface Plan { title: string; destination: { type: "xlsx" | "csv" | "gsheet"; sheet?: string }; [k: string]: unknown }
interface Planned { plan: Plan; description: string[] }
interface Preview { headers: string[]; rows: string[][]; count: number; skipped: { name: string; reason: string }[]; newTab: boolean }
interface Saved { id: string; title: string; instruction: string; plan: Plan; auto: boolean; lastRunAt?: string; lastResult?: string; description: string[] }
interface RunResult { added?: number; file?: { token: string; name: string }; skipped: number; message: string }

const EXAMPLES = [
  "یک فایل اکسل از همهٔ قبولی‌ها و تایید نسبی‌ها با نام، تلفن، امتیاز و شهر",
  "CSV ردشده‌های ۷ روز اخیر با دلیل ضعف‌ها",
  "قبولی‌های بالای ۷۰ را با نام، تلفن و امتیاز به برگهٔ «مصاحبه» گوگل شیت اضافه کن",
];
const runLabel = (p: Plan, count: number) =>
  p.destination.type === "gsheet" ? `افزودن ${fa(count)} ردیف به گوگل شیت` : p.destination.type === "csv" ? "دانلود CSV" : "دانلود اکسل";

function download(r: RunResult) {
  if (r.file) location.href = `/api/files/task/${r.file.token}?name=${encodeURIComponent(r.file.name)}`;
}

export default function TasksPage() {
  const st = useApi<Status>("status").data;
  const src = st?.platforms[0]?.name ?? "jobvision";
  const savedQ = useApi<Saved[]>(`platforms/${src}/tasks`);
  const [text, setText] = useState("");
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [change, setChange] = useState("");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setMsg(null);
    try { await fn(); } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };
  const plan = (instruction: string, previous?: Plan) => run("plan", async () => {
    const p = await api<Planned>(`platforms/${src}/tasks/plan`, { body: { instruction, previous } });
    setPlanned(p); setChange(""); setPreview(null);
    setPreview(await api<Preview>(`platforms/${src}/tasks/preview`, { body: { plan: p.plan } }));
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>خروجی و گزارش</h1>
          <p>بنویسید چه می‌خواهید؛ فایل اکسل، CSV، یا افزودن به گوگل شیت.</p>
        </div>
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <section className="panel panel-pad stack">
          <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="مثلاً: از آگهی نگهبان، قبولی‌ها و نسبی‌های بالای ۷۰ را با نام، تلفن و امتیاز به برگهٔ «مصاحبه» گوگل شیت اضافه کن"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) plan(text); }} />
          <div className="suggest">{EXAMPLES.map((x) => <button key={x} onClick={() => setText(x)}>{x}</button>)}</div>
          <div><button className="btn primary" disabled={!text.trim() || busy !== ""} onClick={() => plan(text)}>{busy === "plan" ? "در حال بررسی…" : "بررسی درخواست"}</button></div>
        </section>

        {msg && <div className={`notice ${msg.cls}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}

        {planned && (
          <section className="panel panel-pad stack">
            <div className="row between">
              <h2>{planned.plan.title}</h2>
              <span className="badge accent">{planned.plan.destination.type === "gsheet" ? "گوگل شیت" : planned.plan.destination.type === "csv" ? "CSV" : "اکسل"}</span>
            </div>
            <ul className="stack" style={{ gap: 4, margin: 0, paddingInlineStart: 18 }}>{planned.description.map((x) => <li key={x}>{x}</li>)}</ul>

            <div className="row">
              <input className="input" value={change} onChange={(e) => setChange(e.target.value)} placeholder="تغییر بده… مثلاً «ستون شهر را هم اضافه کن» یا «فقط تهران»"
                onKeyDown={(e) => { if (e.key === "Enter" && change.trim()) plan(change, planned.plan); }} />
              <button className="btn" disabled={!change.trim() || busy !== ""} onClick={() => plan(change, planned.plan)}>اعمال تغییر</button>
            </div>

            {preview && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="small">
                  {preview.count ? `${fa(preview.count)} ردیف` : "هیچ ردیفی با این شرط پیدا نشد"}
                  {preview.newTab && " · برگهٔ جدید ساخته می‌شود"}
                  {preview.skipped.length > 0 && ` · ${fa(preview.skipped.length)} نفر حذف شدند`}
                </div>
                {preview.count > 0 && (
                  <div className="md-table" style={{ maxHeight: 340, overflow: "auto" }}>
                    <table>
                      <thead><tr>{preview.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                      <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                )}
                {preview.count > preview.rows.length && <div className="small faint">{fa(preview.rows.length)} ردیف اول نمایش داده شده</div>}
                {preview.skipped.length > 0 && (
                  <details>
                    <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>چه کسانی حذف شدند و چرا؟</summary>
                    <ul className="small" style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{preview.skipped.map((x, i) => <li key={i}><b>{x.name}</b>: {x.reason}</li>)}</ul>
                  </details>
                )}
              </div>
            )}

            <div className="row wrap">
              <button className="btn primary" disabled={!preview?.count || busy !== ""} onClick={() => run("run", async () => {
                if (planned.plan.destination.type === "gsheet" && !confirm(`${fa(preview!.count)} ردیف به برگهٔ «${planned.plan.destination.sheet}» اضافه می‌شود. ادامه؟`)) return;
                const r = await api<RunResult>(`platforms/${src}/tasks/run`, { body: { plan: planned.plan } });
                download(r);
                setMsg({ cls: "ok", text: r.message });
                if (r.added) setPreview(await api<Preview>(`platforms/${src}/tasks/preview`, { body: { plan: planned.plan } }));
              })}>{busy === "run" ? "در حال اجرا…" : runLabel(planned.plan, preview?.count ?? 0)}</button>
              <span className="grow" />
              {planned.plan.destination.type === "gsheet" && (
                <label className="row small" style={{ cursor: "pointer" }}><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> بعد از هر امتیازدهی خودکار اجرا شود</label>
              )}
              <button className="btn" disabled={busy !== ""} onClick={() => run("save", async () => {
                await api(`platforms/${src}/tasks`, { body: { title: planned.plan.title, instruction: text, plan: planned.plan, auto } });
                await mutate(`platforms/${src}/tasks`);
                setMsg({ cls: "ok", text: "به‌عنوان قانون ذخیره شد؛ پایین صفحه می‌توانید دوباره اجرایش کنید." });
              })}>ذخیره به‌عنوان قانون</button>
            </div>
          </section>
        )}

        <section className="panel panel-pad stack">
          <h2>قانون‌های ذخیره‌شده</h2>
          {savedQ.firstLoad && <div className="skeleton" style={{ height: 80 }} />}
          {!savedQ.firstLoad && !savedQ.data?.length && <div className="small muted">هنوز قانونی ذخیره نشده. یک درخواست بنویسید و «ذخیره به‌عنوان قانون» را بزنید.</div>}
          {savedQ.data?.map((t) => (
            <div key={t.id} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="row between wrap">
                <b>{t.title}</b>
                <div className="row">
                  {t.plan.destination.type === "gsheet" && (
                    <label className="row small" style={{ cursor: "pointer" }} title="بعد از هر امتیازدهی">
                      خودکار
                      <span className="switch"><input type="checkbox" checked={t.auto} onChange={(e) => run("save", async () => {
                        await api(`platforms/${src}/tasks`, { body: { id: t.id, plan: t.plan, auto: e.target.checked } });
                        await mutate(`platforms/${src}/tasks`);
                      })} /><span /></span>
                    </label>
                  )}
                  <button className="btn sm primary" disabled={busy !== ""} onClick={() => run(`r${t.id}`, async () => {
                    const r = await api<RunResult>(`platforms/${src}/tasks/${t.id}/run`, { body: {} });
                    download(r); setMsg({ cls: "ok", text: `«${t.title}»: ${r.message}` }); await mutate(`platforms/${src}/tasks`);
                  })}>{busy === `r${t.id}` ? "…" : "اجرا"}</button>
                  <button className="btn sm ghost" onClick={() => { setText(t.instruction); setPlanned({ plan: t.plan, description: t.description }); setPreview(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}>ویرایش</button>
                  <button className="btn sm danger" onClick={() => confirm(`قانون «${t.title}» حذف شود؟`) && run("del", async () => {
                    await api(`platforms/${src}/tasks/${t.id}`, { method: "DELETE" }); await mutate(`platforms/${src}/tasks`);
                  })}>حذف</button>
                </div>
              </div>
              <div className="small muted">{t.description.join(" · ")}</div>
              {t.lastRunAt && <div className="small faint">آخرین اجرا: {faDate(t.lastRunAt)} — {t.lastResult}</div>}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
