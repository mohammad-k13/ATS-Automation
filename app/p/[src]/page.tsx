"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fa, faDate, pct, platformName, type Status } from "../../lib/api";

interface Job {
  id: string; title: string; city: string | null; timeDescription: string | null;
  criteriaKind: "job" | "matched" | "default" | "none"; scheduled: boolean;
  stats: { total: number; accepted: number; rejected: number; errors: number; pending: number; avgScore: number | null; lastProcessed: string | null } | null;
  task: { running: boolean; done: number; total: number } | null;
}

const CRIT: Record<Job["criteriaKind"], [string, string]> = {
  job: ["ok", "شرایط تعریف شده"],
  matched: ["ok", "شرایط تعریف شده"],
  default: ["warn", "شرایط عمومی"],
  none: ["bad", "بدون شرایط"],
};

export default function JobsPage() {
  const { src } = useParams<{ src: string }>();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [err, setErr] = useState("");
  const [token, setToken] = useState<Status["platforms"][number]["token"] | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const st = await api<Status>("status");
      const p = st.platforms.find((x) => x.name === src);
      const canAutoLogin = !!(p?.autoLogin.email && p.autoLogin.hasPassword);
      setToken(p?.token ?? null);
      if (!p?.token.valid && !canAutoLogin) return setJobs([]);
      setJobs(null);
      setJobs(await api<Job[]>(`platforms/${src}/jobs`));
      const st2 = await api<Status>("status"); // token may have been renewed by auto-login
      setToken(st2.platforms.find((x) => x.name === src)?.token ?? null);
      window.dispatchEvent(new Event("ats:status"));
    } catch (e: any) {
      setErr(e.message);
      setJobs([]);
    }
  }, [src]);
  useEffect(() => { load(); }, [load]);

  const list = (jobs ?? []).filter((j) => !q || j.title.includes(q));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>آگهی‌های {platformName(src)}</h1>
          <p>آگهی‌های فعال و وضعیت رزومه‌های هرکدام</p>
        </div>
        <div className="row">
          {jobs && jobs.length > 3 && <input className="input" style={{ width: 200 }} placeholder="جستجوی آگهی…" value={q} onChange={(e) => setQ(e.target.value)} />}
          <button className="btn" onClick={load}>↻ به‌روزرسانی</button>
        </div>
      </div>

      {token && !token.valid && jobs !== null && !jobs.length && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          اتصال به {platformName(src)} برقرار نیست. در <Link href="/settings" style={{ textDecoration: "underline" }}>منابع و توکن‌ها</Link> ایمیل و رمز عبور را وارد کنید تا ورود خودکار انجام شود.
        </div>
      )}
      {err && <div className="notice bad" style={{ marginBottom: 16 }}>{err}</div>}

      {jobs === null ? (
        <div className="empty">در حال دریافت آگهی‌ها… {token && !token.valid && "(ورود خودکار به سایت، چند ثانیه صبر کنید)"}</div>
      ) : list.length ? (
        <div className="panel joblist">
          {list.map((j) => {
            const s = j.stats;
            const scored = s ? s.accepted + s.rejected : 0;
            const [cls, label] = CRIT[j.criteriaKind];
            return (
              <Link key={j.id} href={`/p/${src}/jobs/${j.id}?t=${encodeURIComponent(j.title)}`} className="jobrow">
                <div className="grow">
                  <div className="row wrap">
                    <span className="title">{j.title}</span>
                    <span className={`badge ${cls}`}>{label}</span>
                    {j.task?.running && <span className="badge accent">در حال امتیازدهی {fa(j.task.done)}/{fa(j.task.total)}</span>}
                  </div>
                  <div className="small muted">{[j.city, j.timeDescription].filter(Boolean).join(" · ")}</div>
                </div>
                <div>
                  {s && scored ? (
                    <>
                      <div className="meter">
                        <div className="a" style={{ width: `${pct(s.accepted, s.total)}%` }} />
                        <div className="r" style={{ width: `${pct(s.rejected, s.total)}%` }} />
                        <div className="e" style={{ width: `${pct(s.errors, s.total)}%` }} />
                      </div>
                      <div className="nums">
                        <span className="a"><b>{fa(pct(s.accepted, scored))}٪</b> قبول</span>
                        <span className="r"><b>{fa(pct(s.rejected, scored))}٪</b> رد</span>
                        {s.pending > 0 && <span><b>{fa(s.pending)}</b> بررسی‌نشده</span>}
                      </div>
                    </>
                  ) : (
                    <span className="small faint">{s?.total ? `${fa(s.total)} رزومه، هنوز امتیاز نگرفته` : "هنوز بررسی نشده"}</span>
                  )}
                </div>
                <div className="small muted">
                  {s && scored ? <>{fa(scored)} بررسی‌شده<br /><span className="faint">{faDate(s.lastProcessed)}</span></> : null}
                </div>
                <span className="chev">‹</span>
              </Link>
            );
          })}
        </div>
      ) : (
        token?.valid && !err && <div className="empty">آگهی فعالی پیدا نشد.</div>
      )}
    </>
  );
}
