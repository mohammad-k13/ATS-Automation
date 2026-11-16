"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "../lib/api";

interface Row { name: string; source: string; phone: string; receivedAt: string | null; unit: string; jobTitle: string; resumeType: string; status: string; score: number | null }
interface Report { generatedAt: string; filter: { job: string | null; status: string; selected: number }; rows: Row[] }

const COLS: [keyof Row, string][] = [
  ["name", "نام کارجو"], ["source", "منبع"], ["phone", "تلفن"], ["receivedAt", "تاریخ دریافت رزومه"],
  ["unit", "نام واحد"], ["jobTitle", "عنوان شغلی"], ["resumeType", "نوع رزومه"],
];
const faDigits = (s: string) => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
const faDay = (s: string | null) => (s ? new Date(s).toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" }) : "-");
const cell = (r: Row, k: keyof Row) => (k === "receivedAt" ? faDay(r.receivedAt) : k === "phone" ? (r.phone ? faDigits(r.phone) : "-") : String(r[k] ?? "") || "-");

function ReportView() {
  const q = useSearchParams();
  const src = q.get("src") ?? "jobvision";
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const p = new URLSearchParams();
    for (const k of ["job", "status", "ids"]) if (q.get(k)) p.set(k, q.get(k)!);
    api<Report>(`platforms/${src}/report?${p}`).then(setRep).catch((e) => setErr(e.message));
  }, [q, src]);

  const csv = () => {
    if (!rep) return;
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [["ردیف", ...COLS.map(([, l]) => l)].map(esc).join(","), ...rep.rows.map((r, i) => [String(i + 1), ...COLS.map(([k]) => (k === "receivedAt" ? faDay(r.receivedAt) : String(r[k] ?? "")))].map(esc).join(","))];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `گزارش-رزومه-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  if (err) return <div className="notice bad">{err}</div>;
  if (!rep) return <div className="empty">در حال آماده‌سازی گزارش…</div>;
  const title = rep.filter.job ? `گزارش رزومه‌های «${rep.filter.job}»` : "گزارش رزومه‌ها";
  return (
    <div className="report">
      <div className="report-actions no-print">
        <button className="btn" onClick={() => history.back()}>بازگشت</button>
        <span className="grow" />
        <button className="btn" onClick={csv}>دانلود اکسل</button>
        <button className="btn primary" onClick={() => window.print()}>چاپ / ذخیره PDF</button>
      </div>

      <div className="report-sheet">
        <header className="report-head">
          <div>
            <h1>{title}</h1>
            <div className="report-meta">
              <span>وضعیت: {rep.filter.status}</span>
              {rep.filter.selected > 0 && <span>{rep.filter.selected.toLocaleString("fa-IR")} رزومهٔ انتخاب‌شده</span>}
              <span>تعداد: {rep.rows.length.toLocaleString("fa-IR")} نفر</span>
            </div>
          </div>
          <div className="report-date">
            <div>تاریخ گزارش</div>
            <b>{faDay(rep.generatedAt)}</b>
          </div>
        </header>

        {rep.rows.length ? (
          <table className="report-table">
            <thead>
              <tr><th style={{ width: 70 }}>ردیف</th>{COLS.map(([k, l]) => <th key={k}>{l}</th>)}</tr>
            </thead>
            <tbody>
              {rep.rows.map((r, i) => (
                <tr key={i}>
                  <td className="num">{(i + 1).toLocaleString("fa-IR")}</td>
                  {COLS.map(([k]) => <td key={k} className={k === "name" ? "strong" : k === "phone" ? "nowrap" : ""}>{cell(r, k)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">رزومه‌ای با این شرایط وجود ندارد.</div>}
      </div>
    </div>
  );
}

export default function ReportPage() {
  return <Suspense fallback={<div className="empty">…</div>}><ReportView /></Suspense>;
}
