"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "../../../../components/ChatPanel";
import ResumeDrawer from "../../../../components/ResumeDrawer";
import SettingsTab from "../../../../components/SettingsTab";
import { SiteStatusBadge } from "../../../../components/SiteStatus";
import { api, fa, faDate, pct, platformName } from "../../../../lib/api";
import { refresh as refreshCache, Updating, useApi } from "../../../../lib/cache";

interface App {
  id: string; name: string; job: string | null; decision: "accepted" | "partial" | "rejected" | "error" | "pending";
  score: number | null; error: string | null; result: any; extra: any; profileUrl: string | null; appliedAt: string | null; processedAt: string | null;
  siteStatus?: string | null; hasAttachment?: boolean; sheetSyncedAt?: string | null;
}
interface ZipTask { running: boolean; done: number; total: number; current: string | null; token?: string; filename?: string; errors: string[]; error?: string }
interface Task { running: boolean; done: number; total: number; current: string | null; errors: number; error?: string; log: string[]; cancelRequested?: boolean; cancelled?: boolean }

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

  // ---- ZIP downloads
  const zipQ = useApi<ZipTask | null>(`${base}/zip`, { refreshInterval: (t) => (t?.running ? 1500 : 0) });
  const zip = zipQ.data ?? null;
  const zipWasRunning = useRef(false);
  useEffect(() => {
    // when the ZIP is ready, download it once
    if (zipWasRunning.current && zip && !zip.running && zip.token) {
      location.href = `/api/files/zip/${zip.token}?name=${encodeURIComponent(zip.filename ?? "resumes.zip")}`;
    }
    zipWasRunning.current = !!zip?.running;
  }, [zip]);
  const startZip = async (ids?: string[]) => {
    setErr("");
    try { await zipQ.mutate(await api<ZipTask>(`${base}/zip`, { body: ids ? { ids } : { decisions: ["accepted", "partial"] } }), { revalidate: false }); }
    catch (e: any) { setErr(e.message); }
  };

  // ---- reject on Jobvision
  const rejectOnSite = async (ids: string[]) => {
    const n = ids.length;
    if (!confirm(`وضعیت ${n.toLocaleString("fa-IR")} نفر در خود ${platformName(src)} به «رد شده» تغییر می‌کند.\nممکن است جاب‌ویژن این را به کارجو اطلاع دهد. ادامه می‌دهید؟`)) return;
    setBusy("reject"); setErr("");
    try { await api(`${base}/reject`, { body: { ids } }); await appsQ.mutate(); setSel(new Set()); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(""); }
  };

  // ---- Google Sheet for this job
  const sendToSheet = async () => {
    setBusy("sheet"); setErr("");
    try {
      const p = await api<{ count: number; ruleText: string[]; skipped: { name: string; reason: string }[] }>(`platforms/${src}/gsheet/preview`, { body: { jobId: id } });
      const why = p.skipped.length ? `\n\nاضافه نمی‌شوند (${p.skipped.length.toLocaleString("fa-IR")} نفر):\n${p.skipped.slice(0, 15).map((x) => `• ${x.name}: ${x.reason}`).join("\n")}${p.skipped.length > 15 ? "\n…" : ""}` : "";
      if (!p.count) { alert(`کارجوی جدیدی برای افزودن نیست.${why}`); return; }
      if (!confirm(`${p.count.toLocaleString("fa-IR")} نفر به گوگل شیت اضافه می‌شوند.\nشرط: ${p.ruleText.join("، ")}${why}\n\nادامه می‌دهید؟`)) return;
      const r = await api<{ added: number }>(`platforms/${src}/gsheet/sync`, { body: { jobId: id } });
      alert(`${r.added.toLocaleString("fa-IR")} ردیف به شیت اضافه شد.`);
      await appsQ.mutate();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(""); }
  };

  // ---- set Jobvision statuses from the job's map (قبول → تایید اولیه …)
  const applyStatuses = async (ids?: string[]) => {
    setBusy("status"); setErr("");
    try {
      const plan = await api<{ label: string; count: number; names: string[] }[]>(`${base}/site-status/preview`, { body: { ids } });
      if (!plan.length) { alert(`وضعیت همه از قبل درست است؛ تغییری لازم نیست.\n(قانون‌ها در «تنظیمات» ← «وضعیت در ${platformName(src)}»)`); return; }
      const lines = plan.map((g) => `• ${g.count.toLocaleString("fa-IR")} نفر ← «${g.label}»: ${g.names.join("، ")}${g.count > g.names.length ? "، …" : ""}`).join("\n");
      if (!confirm(`این وضعیت‌ها در خود ${platformName(src)} تغییر می‌کند (ممکن است به کارجو اطلاع داده شود):\n\n${lines}\n\nادامه می‌دهید؟`)) return;
      const r = await api<{ done: Record<string, number> }>(`${base}/site-status/apply`, { body: { ids } });
      alert(Object.entries(r.done).map(([k, v]) => `${v.toLocaleString("fa-IR")} نفر ← «${k}»`).join("\n") || "تغییری انجام نشد");
      await appsQ.mutate();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(""); }
  };

  const cancel = async () => {
    try { await taskQ.mutate(await api<Task>(`${base}/score/cancel`, { body: {} }), { revalidate: false }); }
    catch (e: any) { setErr(e.message); }
  };

  /** stop the current run, wait until it has really stopped, then re-score everything with the saved settings */
  const restartScoring = async () => {
    await api<Task>(`${base}/score/cancel`, { body: {} }).catch(() => null);
    for (let i = 0; i < 120; i++) {
      const t = await api<Task | null>(`${base}/task`);
      if (!t?.running) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await taskQ.mutate(await api<Task>(`${base}/score`, { body: { rescore: true } }), { revalidate: false });
  };

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
            <SettingsTab src={src} jobId={id} jobTitle={title} onSaved={() => { settingsQ.mutate(); refreshCache(`platforms/${src}/jobs`); }}
              scoringRunning={running} onRestartScoring={restartScoring} />
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
                  {selIds.length > 0 ? (
                    <>
                      <button className="btn sm" disabled={!!zip?.running} onClick={() => startZip(selIds)}>⬇ دانلود انتخاب‌شده‌ها ({fa(selIds.length)})</button>
                      <button className="btn sm danger" disabled={busy === "reject"} onClick={() => rejectOnSite(selIds)}>{busy === "reject" ? "در حال رد…" : `رد در ${platformName(src)} (${fa(selIds.length)})`}</button>
                    </>
                  ) : (
                    <button className="btn sm" disabled={!!zip?.running || !(counts.accepted + counts.partial)} onClick={() => startZip()}>⬇ دانلود قبول و نسبی ({fa(counts.accepted + counts.partial)})</button>
                  )}
                  <button className="btn sm" disabled={busy === "status"} onClick={() => applyStatuses(selIds.length ? selIds : undefined)}>
                    {busy === "status" ? "در حال اعمال…" : `اعمال وضعیت در ${platformName(src)}${selIds.length ? ` (${fa(selIds.length)})` : ""}`}
                  </button>
                  <button className="btn sm" disabled={busy === "sheet"} onClick={sendToSheet}>{busy === "sheet" ? "در حال ارسال…" : "ارسال به گوگل شیت"}</button>
                  <Link className="btn sm" href={`/report?${new URLSearchParams({ src, job: id, ...(selIds.length ? { ids: selIds.join(",") } : filter !== "all" ? { status: filter } : {}) })}`}>
                    گزارش {selIds.length ? `انتخاب‌شده‌ها (${fa(selIds.length)})` : filter !== "all" ? `«${FILTERS.find(([f]) => f === filter)?.[1]}»` : ""}
                  </Link>
                  <button className="btn sm ghost" disabled={busy === "refresh" || running} onClick={pullFromSite}>{busy === "refresh" ? "در حال دریافت…" : "↻ دریافت از سایت"}</button>
                </div>

                {running && task && (
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
                    <div className="row between small" style={{ marginBottom: 6 }}>
                      <span>{task.cancelRequested ? `در حال توقف… (منتظر پایان «${task.current ?? ""}»)` : `در حال امتیازدهی ${task.current ? `«${task.current}»` : ""}`}</span>
                      <span className="row">
                        <span className="muted">{fa(task.done)} از {fa(task.total)}</span>
                        <button className="btn sm danger" disabled={!!task.cancelRequested} onClick={cancel}>{task.cancelRequested ? "در حال توقف…" : "توقف"}</button>
                      </span>
                    </div>
                    <div className="progress"><div style={{ width: `${pct(task.done, task.total)}%` }} /></div>
                  </div>
                )}
                {!running && task?.error && <div className="notice bad" style={{ margin: 12 }}>{task.error}</div>}
                {zip?.running && (
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
                    <div className="row between small" style={{ marginBottom: 6 }}>
                      <span>در حال آماده‌سازی فایل فشرده {zip.current ? `«${zip.current}»` : ""}</span>
                      <span className="muted">{fa(zip.done)} از {fa(zip.total)}</span>
                    </div>
                    <div className="progress"><div style={{ width: `${pct(zip.done, zip.total)}%` }} /></div>
                  </div>
                )}
                {zip && !zip.running && (zip.error || zip.errors.length > 0) && (
                  <div className={`notice ${zip.error ? "bad" : ""}`} style={{ margin: 12 }}>
                    {zip.error ?? `فایل فشرده ساخته شد، اما برای ${fa(zip.errors.length)} مورد خطا بود:`}
                    {zip.errors.length > 0 && <ul style={{ margin: "6px 0 0", paddingInlineStart: 18 }}>{zip.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>}
                  </div>
                )}
                {!running && task?.cancelled && !task.error && (
                  <div className="notice" style={{ margin: 12 }}>
                    امتیازدهی متوقف شد ({fa(task.done)} از {fa(task.total)} انجام شد). بعد از تغییر تنظیمات، «امتیازدهی مجدد همه» را بزنید.
                  </div>
                )}
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
                              <div className="row wrap"><b>{a.name}</b><span className={`badge ${cls}`}>{label}</span>{a.extra?.experienceAlerts?.length > 0 && <span className="alert-count" title={a.extra.experienceAlerts.join("\n")}>⚠ {fa(a.extra.experienceAlerts.length)}</span>}<SiteStatusBadge status={a.siteStatus} src={src} />{a.sheetSyncedAt && <span className="badge" title="در گوگل شیت ثبت شده">✓ شیت</span>}</div>
                              <div className="small muted">{[a.extra?.lastJob, a.extra?.totalWorkExperienceYears != null ? `${fa(a.extra.totalWorkExperienceYears)} سال سابقه` : null].filter(Boolean).join(" · ")}</div>
                            </td>
                            <td className="sum">
                              {a.result?.hardFilterFailures?.length > 0 && (
                                <div className="error-text" style={{ marginBottom: 4 }}>رد قطعی: {a.result.hardFilterFailures.join("؛ ")}</div>
                              )}
                              {a.result?.summary ?? (a.decision === "error" ? <span className="error-text">{a.error}</span> : <span className="faint">ارسال {faDate(a.appliedAt)}</span>)}
                            </td>
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
          onAsk={(text, aid) => { setOpen(null); setAsk({ text, id: aid }); }}
          onReject={async (aid) => { await rejectOnSite([aid]); refreshCache(`platforms/${src}/applications/${aid}`); }} />
      )}
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="empty">در حال بارگذاری…</div>}><JobPage /></Suspense>;
}
