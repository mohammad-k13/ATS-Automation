"use client";
import { useEffect, useRef, useState } from "react";
import { api, fa, faDate, platformName } from "../lib/api";

const DEC: Record<string, [string, string]> = { accepted: ["ok", "قبول"], rejected: ["bad", "رد"], error: ["warn", "خطا"], pending: ["", "بررسی‌نشده"] };

export default function ResumeDrawer({ src, id, onClose, onScore, onAsk }: { src: string; id: string; onClose: () => void; onScore: (id: string) => void; onAsk: (text: string, id: string) => void }) {
  const [a, setA] = useState<any>(null);
  const [err, setErr] = useState("");
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    setA(null);
    api(`platforms/${src}/applications/${id}`).then(setA).catch((e) => setErr(e.message));
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
            {a?.score != null && <span className={`score ${a.decision === "accepted" ? "ok" : "bad"}`}>{fa(a.score)}</span>}
            {a && <span className={`badge ${cls}`}>{label}</span>}
            <button className="btn ghost" onClick={onClose} aria-label="بستن">✕</button>
          </div>
        </div>
        <div className="drawer-body">
          {err && <div className="notice bad">{err}</div>}
          {a && (
            <>
              <div className="row wrap">
                <button className="btn sm primary" onClick={() => onScore(a.id)}>{a.decision === "pending" ? "امتیازدهی این رزومه" : "امتیازدهی مجدد"}</button>
                <button className="btn sm" onClick={() => onAsk(`چرا ${a.name} ${a.decision === "accepted" ? "پذیرفته" : a.decision === "rejected" ? "رد" : "بررسی"} شده؟ نقاط قوت و ضعفش برای این شغل چیست؟`, a.id)}>پرسیدن از دستیار</button>
                {a.profileUrl && <a className="btn sm" href={a.profileUrl} target="_blank" rel="noreferrer">مشاهده در {platformName(src)} ↗</a>}
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
              {r?.redFlags?.length > 0 && (
                <div className="panel panel-pad">
                  <h3 style={{ color: "var(--warn)" }}>هشدارها</h3>
                  <ul className="pts flag">{r.redFlags.map((x: string) => <li key={x}>{x}</li>)}</ul>
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
