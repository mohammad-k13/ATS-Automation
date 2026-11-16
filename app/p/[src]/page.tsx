"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, fa, faDate, pct, platformName, type Status } from "../../lib/api";
import { mutate, refresh, Updating, useApi } from "../../lib/cache";

interface Job {
  id: string; title: string; city: string | null; timeDescription: string | null;
  criteriaKind: "job" | "matched" | "default" | "none"; scheduled: boolean;
  stats: { total: number; accepted: number; rejected: number; errors: number; pending: number; avgScore: number | null; lastProcessed: string | null } | null;
  task: { running: boolean; done: number; total: number } | null;
}
interface JobsResp { jobs: Job[]; fetchedAt: string | null; error: string | null }

const CRIT: Record<Job["criteriaKind"], [string, string]> = {
  job: ["ok", "شرایط تعریف شده"],
  matched: ["ok", "شرایط تعریف شده"],
  default: ["warn", "شرایط عمومی"],
  none: ["bad", "بدون شرایط"],
};

export default function JobsPage() {
  const { src } = useParams<{ src: string }>();
  const key = `platforms/${src}/jobs`;
  const { data: st } = useApi<Status>("status");
  const { data, error, isValidating, firstLoad } = useApi<JobsResp>(key, { refreshInterval: 60_000 });
  const [q, setQ] = useState("");
  const [forcing, setForcing] = useState(false);
  const token = st?.platforms.find((x) => x.name === src)?.token;

  const forceRefresh = async () => {
    setForcing(true);
    try {
      await mutate(key, await api<JobsResp>(`${key}?fresh=1`), { revalidate: false });
      refresh("status");
    } catch (e: any) {
      await mutate(key, (old: JobsResp | undefined) => (old ? { ...old, error: e.message } : old), { revalidate: false });
    } finally {
      setForcing(false);
    }
  };

  const jobs = data?.jobs ?? [];
  const list = jobs.filter((j) => !q || j.title.includes(q));
  const problem = error?.message ?? data?.error ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>آگهی‌های {platformName(src)}</h1>
          <p className="row">
            آگهی‌های فعال و وضعیت رزومه‌های هرکدام
            {data?.fetchedAt && <span className="faint small">· به‌روزرسانی از سایت: {faDate(data.fetchedAt)}</span>}
            <Updating on={(isValidating || forcing) && !firstLoad} />
          </p>
        </div>
        <div className="row">
          {jobs.length > 3 && <input className="input" style={{ width: 200 }} placeholder="جستجوی آگهی…" value={q} onChange={(e) => setQ(e.target.value)} />}
          <Link className="btn" href={`/report?src=${src}&status=accepted`}>گزارش قبولی‌ها</Link>
          <button className="btn" disabled={forcing} onClick={forceRefresh}>↻ دریافت از سایت</button>
        </div>
      </div>

      {problem && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          {problem}
          {token && !token.valid && <> — <Link href="/settings" style={{ textDecoration: "underline" }}>ورود در تنظیمات</Link></>}
          {data?.jobs.length ? <div className="small">آخرین فهرست ذخیره‌شده نمایش داده می‌شود.</div> : null}
        </div>
      )}

      {firstLoad ? (
        <div className="panel joblist">
          {[0, 1, 2, 3].map((i) => <div key={i} className="jobrow"><div className="skeleton" style={{ height: 22, width: "60%" }} /><div className="skeleton" style={{ height: 8 }} /><div /><div /></div>)}
        </div>
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
        !problem && <div className="empty">آگهی فعالی پیدا نشد.</div>
      )}
    </>
  );
}
