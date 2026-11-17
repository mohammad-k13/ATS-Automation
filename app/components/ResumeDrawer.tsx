"use client";
import { useEffect, useRef } from "react";
import { useApi } from "../lib/cache";
import { SiteStatusBadge } from "./SiteStatus";
import { fa, faDate, platformName } from "../lib/api";

const DEC: Record<string, [string, string]> = { accepted: ["ok", "قبول"], partial: ["partial", "تایید نسبی"], rejected: ["rej", "رد"], error: ["warn", "خطا"], pending: ["", "بررسی‌نشده"] };

export default function ResumeDrawer({ src, id, onClose, onScore, onAsk, onReject }: { src: string; id: string; onClose: () => void; onScore: (id: string) => void; onAsk: (text: string, id: string) => void; onReject?: (id: string) => Promise<void> | void }) {
  const q = useApi<any>(`platforms/${src}/applications/${id}`);
  const a = q.data ?? null;
  const err = q.error?.message ?? "";
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [src, id]);

  const r = a?.result;
  const ex = a?.extra ?? {};
  const [cls, label] = DEC[a?.decision] ?? ["", ""];
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <h2>{a?.name ?? "…"}</h2>
            {a && <div className="small muted">{ex.lastJob ?? ""}</div>}
          </div>
          <div className="row">
            {a?.score != null && <span className={`score ${a.decision === "accepted" ? "ok" : a.decision === "partial" ? "partial" : "rej"}`}>{fa(a.score)}</span>}
            {a && <span className={`badge ${cls}`}>{label}</span>}
            <button className="btn ghost" onClick={onClose} aria-label="بستن">✕</button>
          </div>
        </div>
        <div className="drawer-body">
          {err && <div className="notice bad">{err}</div>}
          {a && (
            <>
              <div className="row wrap">
                <button className="btn sm primary" onClick={() => { onScore(a.id); setTimeout(() => q.mutate(), 4000); }}>{a.decision === "pending" ? "امتیازدهی این رزومه" : "امتیازدهی مجدد"}</button>
                <button className="btn sm" onClick={() => onAsk(`چرا ${a.name} ${a.decision === "accepted" ? "پذیرفته" : a.decision === "partial" ? "تایید نسبی" : a.decision === "rejected" ? "رد" : "بررسی"} شده؟ نقاط قوت و ضعفش برای این شغل چیست؟`, a.id)}>پرسیدن از دستیار</button>
                {a.profileUrl && <a className="btn sm" href={a.profileUrl} target="_blank" rel="noreferrer">مشاهده در {platformName(src)} ↗</a>}
              </div>
              <div className="row wrap">
                <a className="btn sm" href={`/api/platforms/${src}/applications/${a.id}/file/jobvision`}>⬇ رزومهٔ جاب‌ویژن</a>
                {a.hasAttachment && <a className="btn sm" href={`/api/platforms/${src}/applications/${a.id}/file/attached`}>⬇ رزومهٔ پیوست</a>}
                <span className="grow" />
                <SiteStatusBadge status={a.siteStatus} src={src} />
                {a.siteStatus !== "rejected" && onReject && <button className="btn sm danger" onClick={() => onReject(a.id)}>رد در {platformName(src)}</button>}
              </div>

              {r?.summary && <p style={{ margin: 0 }}>{r.summary}</p>}
              {a.error && <div className="notice bad">{a.error}</div>}

              {r && (
                <div className="grid2">
                  <div className="panel panel-pad">
                    <h3 style={{ color: "var(--ok)" }}>نقاط قوت</h3>
                    {r.matched?.length ? <ul className="pts good">{r.matched.map((x: string) => <li key={x}>{x}</li>)}</ul> : <div className="small faint">-</div>}
                  </div>
                  <div className="panel panel-pad">
                    <h3 style={{ color: "var(--bad)" }}>نقاط ضعف</h3>
                    {r.missing?.length ? <ul className="pts weak">{r.missing.map((x: string) => <li key={x}>{x}</li>)}</ul> : <div className="small faint">-</div>}
                  </div>
                </div>
              )}
              {(ex.experienceAlerts?.length > 0 || r?.redFlags?.length > 0 || (a.decision !== "pending" && !ex.experienceAlerts)) && (
                <div className="panel panel-pad alerts">
                  <h3 style={{ color: "var(--warn)" }}>هشدارها</h3>
                  {ex.experienceAlerts?.length > 0 && (
                    <>
                      <div className="alerts-sub">سوابق کاری <span className="faint">(محاسبه از تاریخ‌ها)</span></div>
                      <ul className="pts flag">{ex.experienceAlerts.map((x: string) => <li key={x}>{x}</li>)}</ul>
                    </>
                  )}
                  {Array.isArray(ex.experienceAlerts) && ex.experienceAlerts.length === 0 && (
                    <div className="small" style={{ color: "var(--ok)" }}>✓ سوابق کاری پیوسته است؛ فاصله، تغییر حوزه یا سابقهٔ همزمان دیده نشد.</div>
                  )}
                  {!ex.experienceAlerts && a.decision !== "pending" && (
                    <div className="small faint">بررسی سوابق کاری برای این رزومه انجام نشده؛ «امتیازدهی مجدد» را بزنید.</div>
                  )}
                  {r?.redFlags?.length > 0 && (
                    <>
                      <div className="alerts-sub">از نظر هوش مصنوعی</div>
                      <ul className="pts flag">{r.redFlags.map((x: string) => <li key={x}>{x}</li>)}</ul>
                    </>
                  )}
                </div>
              )}
              {r?.hardFilterFailures?.length > 0 && <div className="notice bad">رد به دلیل شرط قطعی: {r.hardFilterFailures.join("، ")}</div>}

              <dl className="kv">
                <dt>سابقه کار</dt><dd>{ex.totalWorkExperienceYears != null ? `${fa(ex.totalWorkExperienceYears)} سال` : "-"}</dd>
                <dt>شهر</dt><dd>{ex.city ?? "-"}</dd>
                <dt>حقوق درخواستی</dt><dd>{ex.requestedSalary ?? "-"}</dd>
                <dt>تحصیلات</dt><dd>{ex.lastEducation ?? "-"}</dd>
                <dt>امتیاز {platformName(src)}</dt><dd>{ex.jobvisionMatchScore != null ? fa(ex.jobvisionMatchScore) : "-"}</dd>
                <dt>تاریخ ارسال</dt><dd>{faDate(a.appliedAt)}</dd>
                {a.processedAt && <><dt>آخرین بررسی</dt><dd>{faDate(a.processedAt)}</dd></>}
              </dl>

              <div>
                <h3 style={{ marginBottom: 8 }}>متن رزومه</h3>
                {a.resumeText ? <div className="resume-text">{a.resumeText}</div> : <div className="small faint">متن رزومه بعد از امتیازدهی نمایش داده می‌شود.</div>}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
