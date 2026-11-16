"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { platformName } from "../lib/api";
import { useApi } from "../lib/cache";

type Crumb = { label: string; href?: string };

function useCrumbs(): { crumbs: Crumb[]; parent: string | null } {
  const path = usePathname();
  const params = useParams<{ src?: string; id?: string }>();
  const search = useSearchParams();
  const src = params.src ?? search.get("src") ?? undefined;
  // job titles come from the cached jobs list (no extra loading)
  const jobs = useApi<{ jobs: { id: string; title: string }[] }>(src && (params.id || search.get("job")) ? `platforms/${src}/jobs` : null, { revalidateOnFocus: false, revalidateIfStale: false });
  const jobId = params.id ?? search.get("job") ?? undefined;
  // same keys the pages use, so these come from the cache (no extra requests)
  const apps = useApi<{ job: string | null }[]>(src && jobId ? `platforms/${src}/jobs/${jobId}/applications` : null, { revalidateOnFocus: false });
  const jobTitle =
    search.get("t") || jobs.data?.jobs.find((j) => j.id === jobId)?.title || apps.data?.find((a) => a.job)?.job || (jobId ? `آگهی ${jobId}` : "");

  if (path.startsWith("/settings")) return { crumbs: [{ label: "تنظیمات و اتصال‌ها" }], parent: "/" };
  if (path.startsWith("/report")) {
    const c: Crumb[] = [];
    if (src) c.push({ label: `آگهی‌های ${platformName(src)}`, href: `/p/${src}` });
    if (jobId && src) c.push({ label: jobTitle, href: `/p/${src}/jobs/${jobId}` });
    c.push({ label: "گزارش" });
    return { crumbs: c, parent: jobId && src ? `/p/${src}/jobs/${jobId}` : src ? `/p/${src}` : "/" };
  }
  if (src && params.id) return { crumbs: [{ label: `آگهی‌های ${platformName(src)}`, href: `/p/${src}` }, { label: jobTitle }], parent: `/p/${src}` };
  if (src) return { crumbs: [{ label: `آگهی‌های ${platformName(src)}` }], parent: null };
  return { crumbs: [{ label: "داشبورد" }], parent: null };
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"), []);
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("ats-theme", t); } catch { /* ignore */ }
  };
  return (
    <button className="btn sm theme-btn" onClick={flip} title="تغییر حالت نمایش" aria-label="تغییر حالت نمایش">
      <span aria-hidden>{theme === "dark" ? "☀" : "☾"}</span>
      <span className="l">{theme === "dark" ? "حالت روشن" : "حالت تیره"}</span>
    </button>
  );
}

function Logout() {
  const me = useApi<{ enabled: boolean; user: string | null }>("auth/me", { revalidateOnFocus: false });
  if (!me.data?.enabled || !me.data.user) return null;
  const out = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    try {
      localStorage.setItem("ats-cache-v1", "[]");
    } catch {
      /* ignore */
    }
    location.href = "/login";
  };
  return (
    <button className="btn sm ghost" onClick={out} title={me.data.user}>
      خروج ({me.data.user})
    </button>
  );
}

function HeaderInner() {
  const router = useRouter();
  const { crumbs, parent } = useCrumbs();
  const path = usePathname();
  if (path.startsWith("/login")) return null;
  const back = () => {
    if (window.history.length > 1 && document.referrer.startsWith(location.origin)) router.back();
    else router.push(parent ?? "/");
  };
  const canGoBack = parent !== null;
  return (
    <header className="app-header">
      {canGoBack && <button className="back" onClick={back} aria-label="بازگشت" title="بازگشت">→</button>}
      <nav className="crumbs grow" aria-label="مسیر">
        {crumbs.map((c, i) => (
          <span key={i} className="row" style={{ gap: 8, minWidth: 0 }}>
            {i > 0 && <span className="sep">‹</span>}
            {c.href && i < crumbs.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span className="cur">{c.label}</span>}
          </span>
        ))}
      </nav>
      <Logout />
      <ThemeToggle />
    </header>
  );
}

export default function Header() {
  return <Suspense fallback={<header className="app-header" />}><HeaderInner /></Suspense>;
}
