"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, platformName, type Status } from "../lib/api";

export function tokenState(t: Status["platforms"][number]["token"]) {
  if (!t.hasToken) return { cls: "bad", label: "بدون توکن" };
  if (!t.valid) return { cls: "bad", label: "توکن منقضی" };
  const mins = Math.round((new Date(t.expiresAt!).getTime() - Date.now()) / 60000);
  const label = mins >= 60 ? `${Math.floor(mins / 60).toLocaleString("fa-IR")} ساعت` : `${mins.toLocaleString("fa-IR")} دقیقه`;
  return { cls: mins < 30 ? "warn" : "ok", label };
}

export default function Sidebar() {
  const path = usePathname();
  const [st, setSt] = useState<Status | null>(null);
  useEffect(() => {
    const load = () => api<Status>("status").then(setSt).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    window.addEventListener("ats:status", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("ats:status", load);
    };
  }, []);

  return (
    <nav className="sidebar">
      <div className="logo"><i />سامانه جذب</div>
      <div className="nav-title">پلتفرم‌ها</div>
      {st?.platforms.map((p) => {
        const ts = tokenState(p.token);
        return (
          <Link key={p.name} href={`/p/${p.name}`} className={`nav-item ${path.startsWith(`/p/${p.name}`) ? "active" : ""}`}>
            <span>{platformName(p.name)}</span>
            <span className="row small faint" title={`توکن: ${ts.label}`}><span className={`dot ${ts.cls}`} /></span>
          </Link>
        );
      })}
      {st && !st.platforms.length && <div className="small faint" style={{ padding: "0 10px" }}>پلتفرمی فعال نیست</div>}
      <div className="nav-title">تنظیمات</div>
      <Link href="/settings" className={`nav-item ${path.startsWith("/settings") ? "active" : ""}`}>
        <span>منابع و توکن‌ها</span>
      </Link>
      <div className="bottom small faint" style={{ padding: "0 10px" }}>
        {st && (st.ai.provider === "keyword" ? <span className="badge warn">هوش مصنوعی خاموش</span> : <span className="ltr">AI · {st.ai.model}</span>)}
      </div>
    </nav>
  );
}
