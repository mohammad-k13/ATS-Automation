"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fa, platformName } from "../lib/api";
import TagsInput from "./TagsInput";

interface Criteria {
  threshold: number; mustHave: string[]; niceToHave: string[];
  hardFilters: { minYears: number | null; requireAny: string[]; rejectIfAny: string[] };
  instructions: string;
}
interface Settings { criteria: Criteria | null; criteriaKind: string; criteriaName: string | null; scheduled: boolean; sourceStatus: number }

const EMPTY: Criteria = { threshold: 70, mustHave: [], niceToHave: [], hardFilters: { minYears: null, requireAny: [], rejectIfAny: [] }, instructions: "" };

export default function SettingsTab({ src, jobId, jobTitle, onSaved }: { src: string; jobId: string; jobTitle: string; onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [c, setC] = useState<Criteria>(EMPTY);
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "save">("");
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api<Settings>(`platforms/${src}/jobs/${jobId}/settings`).then((x) => {
      setS(x);
      setC(x.criteria ?? EMPTY);
    }).catch((e) => setMsg({ cls: "bad", text: e.message }));
  }, [src, jobId]);

  const upd = (patch: Partial<Criteria>) => { setC((o) => ({ ...o, ...patch })); setDirty(true); };
  const updHF = (patch: Partial<Criteria["hardFilters"]>) => { setC((o) => ({ ...o, hardFilters: { ...o.hardFilters, ...patch } })); setDirty(true); };

  const draft = async () => {
    setBusy("draft"); setMsg(null);
    try {
      const d = await api<Criteria>(`platforms/${src}/jobs/${jobId}/criteria/draft`, { body: { jobTitle, description: desc, current: s?.criteriaKind === "job" ? c : null } });
      setC({ ...EMPTY, ...d, hardFilters: { ...EMPTY.hardFilters, ...d.hardFilters } });
      setDirty(true);
      setMsg({ cls: "", text: "پیش‌نویس شرایط آماده شد. بررسی و در صورت نیاز ویرایش کنید، سپس «ذخیره» را بزنید." });
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };

  const save = async () => {
    setBusy("save"); setMsg(null);
    try {
      const x = await api<Settings>(`platforms/${src}/jobs/${jobId}/criteria`, { method: "PUT", body: { criteria: c, jobTitle } });
      setS(x); setDirty(false);
      setMsg({ cls: "ok", text: "ذخیره شد. برای اعمال شرایط جدید روی رزومه‌های قبلی، در تب رزومه‌ها «امتیازدهی مجدد» را بزنید." });
      onSaved();
    } catch (e: any) { setMsg({ cls: "bad", text: e.message }); } finally { setBusy(""); }
  };

  const toggleScheduled = async (on: boolean) => {
    try { setS(await api<Settings>(`platforms/${src}/jobs/${jobId}/scheduled`, { method: "PUT", body: { on } })); }
    catch (e: any) { setMsg({ cls: "bad", text: e.message }); }
  };

  if (!s) return <div className="empty">در حال بارگذاری…</div>;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <section className="panel panel-pad stack">
        <div className="section-title">
          <div>
            <h2>شرایط آگهی</h2>
            <div className="small muted">
              {s.criteriaKind === "job" ? "شرایط اختصاصی این آگهی" : s.criteriaKind === "default" ? "هنوز شرایط اختصاصی ندارد؛ از شرایط عمومی استفاده می‌شود" : s.criteriaKind === "none" ? "هنوز شرایطی تعریف نشده" : `از فایل ${s.criteriaName}`}
            </div>
          </div>
          {dirty && <span className="badge warn">ذخیره‌نشده</span>}
        </div>

        <label className="field">
          <span>توضیح شغل به زبان ساده</span>
          <small>هر چیزی که دنبالش هستید را مثل صحبت با یک کارشناس استخدام بنویسید. هوش مصنوعی آن را به شرایط زیر تبدیل می‌کند.</small>
          <textarea className="textarea" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)}
            placeholder="مثلاً: دنبال یک مدیر تولید برای کارخانه‌مان در نجف‌آباد هستیم. حداقل ۵ سال سابقهٔ مدیریت تولید در صنعت لازم است، آشنایی با برنامه‌ریزی تولید و کنترل کیفیت مهم است و اگر با ERP کار کرده باشد بهتر است…" />
        </label>
        <div><button className="btn" disabled={!desc.trim() || busy !== ""} onClick={draft}>{busy === "draft" ? "در حال ساخت…" : "ساخت شرایط با هوش مصنوعی"}</button></div>

        <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%", margin: "4px 0" }} />

        <label className="field">
          <span>مهارت‌ها و تجربه‌های الزامی</span>
          <small>هر مورد را بنویسید و Enter بزنید</small>
          <TagsInput value={c.mustHave} onChange={(v) => upd({ mustHave: v })} placeholder="مثلاً مدیریت تولید" />
        </label>
        <label className="field">
          <span>امتیاز اضافه (اختیاری)</span>
          <TagsInput value={c.niceToHave} onChange={(v) => upd({ niceToHave: v })} placeholder="مثلاً ERP" />
        </label>
        <div className="grid2">
          <label className="field">
            <span>حداقل امتیاز قبولی: {fa(c.threshold)}</span>
            <input type="range" min={0} max={100} step={5} value={c.threshold} onChange={(e) => upd({ threshold: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>حداقل سابقهٔ کار (سال)</span>
            <input className="input" type="number" min={0} value={c.hardFilters.minYears ?? ""} placeholder="بدون محدودیت"
              onChange={(e) => updHF({ minYears: e.target.value === "" ? null : Number(e.target.value) })} />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>حتماً یکی از این‌ها را داشته باشد</span>
            <TagsInput value={c.hardFilters.requireAny} onChange={(v) => updHF({ requireAny: v })} placeholder="اختیاری" />
          </label>
          <label className="field">
            <span>اگر این‌ها را داشت رد شود</span>
            <TagsInput value={c.hardFilters.rejectIfAny} onChange={(v) => updHF({ rejectIfAny: v })} placeholder="اختیاری" />
          </label>
        </div>
        <label className="field">
          <span>توضیحات برای هوش مصنوعی</span>
          <small>اولویت‌ها، چیزهایی که مهم است و چیزهایی که امتیاز را کم می‌کند</small>
          <textarea className="textarea" rows={5} value={c.instructions} onChange={(e) => upd({ instructions: e.target.value })} />
        </label>

        {msg && <div className={`notice ${msg.cls}`}>{msg.text}</div>}
        <div className="row"><button className="btn primary" disabled={busy !== "" || (!dirty && s.criteriaKind === "job")} onClick={save}>{busy === "save" ? "در حال ذخیره…" : "ذخیره شرایط"}</button></div>
      </section>

      <section className="panel panel-pad stack">
        <h2>تنظیمات منبع</h2>
        <div className="row between">
          <div>
            <h3>بررسی خودکار</h3>
            <div className="small muted">اگر فعال باشد، اجرای زمان‌بندی‌شده (<span className="ltr">npm run schedule</span>) رزومه‌های جدید این آگهی را هم بررسی می‌کند و قبولی‌ها را به تلگرام می‌فرستد.</div>
          </div>
          <label className="switch"><input type="checkbox" checked={s.scheduled} onChange={(e) => toggleScheduled(e.target.checked)} /><span /></label>
        </div>
        <div className="small muted">
          فقط رزومه‌هایی که در {platformName(src)} هنوز «تعیین وضعیت نشده» هستند دریافت می‌شوند (وضعیت {fa(s.sourceStatus)}). سایر تنظیمات منبع در صفحهٔ <Link href="/settings" style={{ color: "var(--accent)" }}>منابع و توکن‌ها</Link> است.
        </div>
      </section>
    </div>
  );
}
