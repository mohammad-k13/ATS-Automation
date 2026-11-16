"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "../../../../components/ChatPanel";
import ResumeDrawer from "../../../../components/ResumeDrawer";
import SettingsTab from "../../../../components/SettingsTab";
import { api, fa, faDate, pct, platformName } from "../../../../lib/api";

interface App {
  id: string; name: string; job: string | null; decision: "accepted" | "rejected" | "error" | "pending";
  score: number | null; error: string | null; result: any; extra: any; profileUrl: string | null; appliedAt: string | null; processedAt: string | null;
}
interface Task { running: boolean; done: number; total: number; current: string | null; errors: number; error?: string; log: string[] }

const DEC: Record<App["decision"], [string, string]> = { accepted: ["ok", "قبول"], rejected: ["bad", "رد"], error: ["warn", "خطا"], pending: ["", "بررسی‌نشده"] };
const FILTERS: [string, string][] = [["all", "همه"], ["accepted", "قبول"], ["rejected", "رد"], ["pending", "بررسی‌نشده"], ["error", "خطا"]];

function JobPage() {
  const { src, id } = useParams<{ src: string; id: string }>();
  const search = useSearchParams();
  const [tab, setTab] = useState<"resumes" | "settings">("resumes");
  const [apps, setApps] = useState<App[] | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [ask, setAsk] = useState<{ text: string; id?: string } | null>(null);
  const [hasCriteria, setHasCriteria] = useState<string>("");
  const triedRefresh = useRef(false);

  const title = search.get("t") || apps?.find((a) => a.job)?.job || `آگهی ${id}`;

  const loadApps = useCallback(async () => {
    const list = await api<App[]>(`platforms/${src}/jobs/${id}/applications`);
    setApps(list);
    return list;
  }, [src, id]);

  const refresh = useCallback(async () => {
    setBusy("refresh"); setErr("");
    try { await api(`platforms/${src}/jobs/${id}/refresh`, { body: {} }); await loadApps(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(""); }
  }, [src, id, loadApps]);

  const loadSettings = useCallback(() => {
    api(`platforms/${src}/jobs/${id}/settings`).then((s: any) => setHasCriteria(s.criteriaKind)).catch(() => {});
  }, [src, id]);

  // first load: show what we have, pull the list from the site if empty
  useEffect(() => {
    loadSettings();
    loadApps().then((list) => { if (!list.length && !triedRefresh.current) { triedRefresh.current = true; refresh(); } }).catch((e) => setErr(e.message));
    api<Task | null>(`platforms/${src}/jobs/${id}/task`).then(setTask).catch(() => {});
  }, [src, id, loadApps, refresh, loadSettings]);

  // poll while scoring
  useEffect(() => {
    if (!task?.running) return;
    const t = setInterval(async () => {
      const x = await api<Task | null>(`platforms/${src}/jobs/${id}/task`).catch(() => null);
      setTask(x);
      loadApps().catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [task?.running, src, id, loadApps]);

  const score = async (opts: { ids?: string[]; rescore?: boolean }) => {
    setErr("");
    try { setTask(await api<Task>(`platforms/${src}/jobs/${id}/score`, { body: opts })); }
    catch (e: any) { setErr(e.message); }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, accepted: 0, rejected: 0, pending: 0, error: 0 };
    (apps ?? []).forEach((a) => { c.all++; c[a.decision]++; });
    return c;
  }, [apps]);
  const scored = counts.accepted + counts.rejected;
  const avg = useMemo(() => {
    const s = (apps ?? []).filter((a) => a.decision === "accepted" || a.decision === "rejected").map((a) => a.score ?? 0);
    return s.length ? Math.round(s.reduce((x, y) => x + y, 0) / s.length) : null;
  }, [apps]);
  const list = (apps ?? []).filter((a) => filter === "all" || a.decision === filter);
  const selIds = [...sel];
  const allSel = list.length > 0 && list.every((a) => sel.has(a.id));
  const toggle = (aid: string) => setSel((s) => { const n = new Set(s); n.has(aid) ? n.delete(aid) : n.add(aid); return n; });
  const running = !!task?.running;
  const noCriteria = hasCriteria === "none" || hasCriteria === "default";

  return (
    <>
      <div className="job-layout">
        <div>
          <div className="small" style={{ marginBottom: 8 }}><Link href={`/p/${src}`} className="muted">آگهی‌های {platformName(src)} ›</Link></div>
          <div className="page-head">
            <div>
              <h1>{title}</h1>
              <p>{fa(counts.all)} رزومه · {fa(scored)} بررسی‌شده</p>
            </div>
          </div>
          <div className="tabs">
            <button className={`tab ${tab === "resumes" ? "on" : ""}`} onClick={() => setTab("resumes")}>رزومه‌ها</button>
            <button className={`tab ${tab === "settings" ? "on" : ""}`} onClick={() => setTab("settings")}>تنظیمات {noCriteria && <span className="dot warn" style={{ display: "inline-block", marginInlineStart: 4 }} />}</button>
          </div>

          {tab === "settings" ? (
            <SettingsTab src={src} jobId={id} jobTitle={title} onSaved={loadSettings} />
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
                <div className="panel stat"><div className="v" style={{ color: "var(--bad)" }}>{fa(pct(counts.rejected, scored))}٪</div><div className="l">رد ({fa(counts.rejected)})</div></div>
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
                  <button className="btn sm ghost" disabled={busy === "refresh" || running} onClick={refresh}>{busy === "refresh" ? "در حال دریافت…" : "↻ دریافت از سایت"}</button>
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

                {apps === null ? <div className="empty">در حال بارگذاری…</div> : list.length ? (
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
                            <td>{a.score != null && a.decision !== "pending" ? <span className={`score ${a.decision === "accepted" ? "ok" : "bad"}`}>{fa(a.score)}</span> : <span className="faint">—</span>}</td>
                            <td>
                              <div className="row wrap"><b>{a.name}</b><span className={`badge ${cls}`}>{label}</span></div>
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
