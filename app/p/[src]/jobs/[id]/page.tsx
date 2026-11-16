"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "../../../../components/ChatPanel";
import ResumeDrawer from "../../../../components/ResumeDrawer";
import SettingsTab from "../../../../components/SettingsTab";
import { api, fa, faDate, pct, platformName } from "../../../../lib/api";
import { refresh as refreshCache, Updating, useApi } from "../../../../lib/cache";

interface App {
  id: string; name: string; job: string | null; decision: "accepted" | "partial" | "rejected" | "error" | "pending";
  score: number | null; error: string | null; result: any; extra: any; profileUrl: string | null; appliedAt: string | null; processedAt: string | null;
}
interface Task { running: boolean; done: number; total: number; current: string | null; errors: number; error?: string; log: string[] }

const DEC: Record<App["decision"], [string, string]> = { accepted: ["ok", "قبول"], partial: ["partial", "تایید نسبی"], rejected: ["rej", "رد"], error: ["warn", "خطا"], pending: ["", "بررسی‌نشده"] };
const FILTERS: [string, string][] = [["all", "همه"], ["accepted", "قبول"], ["partial", "تایید نسبی"], ["rejected", "رد"], ["pending", "بررسی‌نشده"], ["error", "خطا"]];

function JobPage() {
  const { src, id } = useParams<{ src: string; id: string }>();
  const search = useSearchParams();
  const [tab, setTab] = useState<"resumes" | "settings">("resumes");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [ask, setAsk] = useState<{ text: string; id?: string } | null>(null);
  const triedRefresh = useRef(false);

  const base = `platforms/${src}/jobs/${id}`;
  const taskQ = useApi<Task | null>(`${base}/task`, { refreshInterval: (t) => (t?.running ? 2000 : 0) });
  const task = taskQ.data ?? null;
  const running = !!task?.running;
  const appsQ = useApi<App[]>(`${base}/applications`, { refreshInterval: running ? 2000 : 0 });
  const apps = appsQ.data ?? null;
  const settingsQ = useApi<{ criteriaKind: string }>(`${base}/settings`);
  const hasCriteria = settingsQ.data?.criteriaKind ?? "";

  const title = search.get("t") || apps?.find((a) => a.job)?.job || `آگهی ${id}`;

  // when a scoring run finishes, refresh everything that depends on it
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) { appsQ.mutate(); refreshCache(`platforms/${src}/jobs`); }
    wasRunning.current = running;
  }, [running, appsQ, src]);

  const pullFromSite = useCallback(async () => {
    setBusy("refresh"); setErr("");
    try { await api(`${base}/refresh`, { body: {} }); await appsQ.mutate(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(""); }
  }, [base, appsQ]);

  // never seen this job: pull its resumes from the site once
  useEffect(() => {
    if (apps && !apps.length && !triedRefresh.current) { triedRefresh.current = true; pullFromSite(); }
  }, [apps, pullFromSite]);

  const score = async (opts: { ids?: string[]; rescore?: boolean }) => {
    setErr("");
    try { await taskQ.mutate(await api<Task>(`${base}/score`, { body: opts }), { revalidate: false }); }
    catch (e: any) { setErr(e.message); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, accepted: 0, partial: 0, rejected: 0, pending: 0, error: 0 };
    (apps ?? []).forEach((a) => { c.all++; c[a.decision]++; });
    return c;
  }, [apps]);
  const scored = counts.accepted + counts.partial + counts.rejected;
  const avg = useMemo(() => {
    const s = (apps ?? []).filter((a) => a.decision === "accepted" || a.decision === "partial" || a.decision === "rejected").map((a) => a.score ?? 0);
    return s.length ? Math.round(s.reduce((x, y) => x + y, 0) / s.length) : null;
  }, [apps]);
  const list = (apps ?? []).filter((a) => filter === "all" || a.decision === filter);
  const selIds = [...sel];
  const allSel = list.length > 0 && list.every((a) => sel.has(a.id));
  const toggle = (aid: string) => setSel((s) => { const n = new Set(s); n.has(aid) ? n.delete(aid) : n.add(aid); return n; });
  const noCriteria = hasCriteria === "none" || hasCriteria === "default";

  return (
    <>
      <div className="job-layout">
        <div>
          <div className="page-head">
            <div>
              <h1>{title}</h1>
              <p className="row">{fa(counts.all)} رزومه · {fa(scored)} بررسی‌شده <Updating on={(appsQ.isValidating && !running && !appsQ.firstLoad) || busy === "refresh"} /></p>
            </div>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === "resumes" ? "on" : ""}`} onClick={() => setTab("resumes")}>رزومه‌ها</button>
            <button className={`tab ${tab === "settings" ? "on" : ""}`} onClick={() => setTab("settings")}>تنظیمات {noCriteria && <span className="dot warn" style={{ display: "inline-block", marginInlineStart: 4 }} />}</button>
          </div>

          {tab === "settings" ? (
            <SettingsTab src={src} jobId={id} jobTitle={title} onSaved={() => { settingsQ.mutate(); refreshCache(`platforms/${src}/jobs`); }} />
          ) : (
            <>
              {noCriteria && (
                <div className="notice" style={{ marginBottom: 14 }}>
                  {hasCriteria === "none" ? "برای این آگهی هنوز شرایطی تعریف نشده." : "این آگهی شرایط اختصاصی ندارد و با شرایط عمومی بررسی می‌شود."}{" "}
                  <button className="btn sm" onClick={() => setTab("settings")}>تعریف شرایط</button>
                </div>
              )}

              <div className="stats">
                <div className="panel stat"><div className="v">{fa(counts.all)}</div><div className="l">کل رزومه‌ها</div></div>
                <div className="panel stat"><div className="v" style={{ color: "var(--ok)" }}>{fa(pct(counts.accepted, scored))}٪</div><div className="l">قبول ({fa(counts.accepted)})</div></div>
                <div className="panel stat"><div className="v" style={{ color: "var(--warn)" }}>{fa(pct(counts.partial, scored))}٪</div><div className="l">تایید نسبی ({fa(counts.partial)})</div></div>
                <div className="panel stat"><div className="v" style={{ color: "var(--rej)" }}>{fa(pct(counts.rejected, scored))}٪</div><div className="l">رد ({fa(counts.rejected)})</div></div>
                <div className="panel stat"><div className="v">{fa(avg)}</div><div className="l">میانگین امتیاز</div></div>
              </div>

              <div className="panel">
                <div className="toolbar">
                  <button className="btn primary sm" disabled={running || !counts.pending && !counts.error} onClick={() => score({})}>
                    امتیازدهی رزومه‌های جدید {counts.pending + counts.error > 0 && `(${fa(counts.pending + counts.error)})`}
                  </button>
                  <button className="btn sm" disabled={running || !selIds.length} onClick={() => score({ ids: selIds, rescore: true })}>
                    امتیازدهی انتخاب‌شده‌ها {selIds.length > 0 && `(${fa(selIds.length)})`}
                  </button>
                  <button className="btn sm" disabled={running || !scored} onClick={() => confirm("همهٔ رزومه‌ها دوباره امتیاز بگیرند؟") && score({ rescore: true })}>امتیازدهی مجدد همه</button>
                  <span className="grow" />
                  <Link className="btn sm" href={`/report?${new URLSearchParams({ src, job: id, ...(selIds.length ? { ids: selIds.join(",") } : filter !== "all" ? { status: filter } : {}) })}`}>
                    گزارش {selIds.length ? `انتخاب‌شده‌ها (${fa(selIds.length)})` : filter !== "all" ? `«${FILTERS.find(([f]) => f === filter)?.[1]}»` : ""}
                  </Link>
                  <button className="btn sm ghost" disabled={busy === "refresh" || running} onClick={pullFromSite}>{busy === "refresh" ? "در حال دریافت…" : "↻ دریافت از سایت"}</button>
                </div>

                {running && task && (
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
                    <div className="row between small" style={{ marginBottom: 6 }}>
                      <span>در حال امتیازدهی {task.current ? `«${task.current}»` : ""}</span>
                      <span className="muted">{fa(task.done)} از {fa(task.total)}</span>
                    </div>
                    <div className="progress"><div style={{ width: `${pct(task.done, task.total)}%` }} /></div>
                  </div>
                )}
                {!running && task?.error && <div className="notice bad" style={{ margin: 12 }}>{task.error}</div>}
                {err && <div className="notice bad" style={{ margin: 12 }}>{err}</div>}

                <div className="toolbar" style={{ paddingBlock: 6 }}>
                  <div className="chips">
                    {FILTERS.map(([f, l]) => (counts[f] || f === "all") ? <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{l} {fa(counts[f])}</button> : null)}
                  </div>
                  {selIds.length > 0 && <><span className="grow" /><button className="btn sm ghost" onClick={() => setSel(new Set())}>لغو انتخاب ({fa(selIds.length)})</button></>}
                </div>

                {apps === null ? <div style={{ padding: 14 }} className="stack">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}</div> : list.length ? (
                  <table className="list">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(list.map((a) => a.id)))} /></th>
                        <th style={{ width: 64 }}>امتیاز</th>
                        <th>نام</th>
                        <th>خلاصه</th>
                        <th style={{ width: 90 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((a) => {
                        const [cls, label] = DEC[a.decision];
                        return (
                          <tr key={a.id} className={sel.has(a.id) ? "sel" : ""} onClick={() => setOpen(a.id)}>
                            <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(a.id)} onChange={() => toggle(a.id)} /></td>
                            <td>{a.score != null && a.decision !== "pending" ? <span className={`score ${a.decision === "accepted" ? "ok" : a.decision === "partial" ? "partial" : "rej"}`}>{fa(a.score)}</span> : <span className="faint">—</span>}</td>
                            <td>
                              <div className="row wrap"><b>{a.name}</b><span className={`badge ${cls}`}>{label}</span>{a.extra?.experienceAlerts?.length > 0 && <span className="alert-count" title={a.extra.experienceAlerts.join("\n")}>⚠ {fa(a.extra.experienceAlerts.length)}</span>}</div>
                              <div className="small muted">{[a.extra?.lastJob, a.extra?.totalWorkExperienceYears != null ? `${fa(a.extra.totalWorkExperienceYears)} سال سابقه` : null].filter(Boolean).join(" · ")}</div>
                            </td>
                            <td className="sum">{a.result?.summary ?? (a.decision === "error" ? <span className="error-text">{a.error}</span> : <span className="faint">ارسال {faDate(a.appliedAt)}</span>)}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <button className="btn sm" disabled={running} onClick={() => score({ ids: [a.id], rescore: true })}>{a.decision === "pending" ? "امتیازدهی" : "مجدد"}</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <div className="empty">{busy === "refresh" ? "در حال دریافت رزومه‌ها از سایت…" : "رزومه‌ای در این دسته نیست."}</div>}
              </div>
            </>
          )}
        </div>

        <ChatPanel src={src} jobId={id} focusIds={selIds} pending={ask} onPendingUsed={() => setAsk(null)} />
      </div>

      {open && (
        <ResumeDrawer src={src} id={open} onClose={() => setOpen(null)}
          onScore={(aid) => { score({ ids: [aid], rescore: true }); }}
          onAsk={(text, aid) => { setOpen(null); setAsk({ text, id: aid }); }} />
      )}
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="empty">در حال بارگذاری…</div>}><JobPage /></Suspense>;
}
