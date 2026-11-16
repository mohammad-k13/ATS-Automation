"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "../lib/api";

const CACHE_KEY = "ats-cache-v1";

function LoginForm() {
  const next = useSearchParams().get("next") || "/";
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("auth/login", { body: { user, password } });
      try {
        localStorage.setItem(CACHE_KEY, "[]");
      } catch {
        /* ignore */
      }
      location.href = next.startsWith("/") ? next : "/";
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "70vh", display: "grid", placeItems: "center" }}>
      <form className="panel panel-pad stack" style={{ width: "min(380px, 100%)", gap: 14 }} onSubmit={submit}>
        <h1>ورود به سامانهٔ جذب</h1>
        <label className="field">
          <span>نام کاربری</span>
          <input className="input ltr" style={{ textAlign: "left" }} autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>رمز عبور</span>
          <input className="input ltr" style={{ textAlign: "left" }} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="notice bad">{err}</div>}
        <button className="btn primary" disabled={busy || !user || !password}>
          {busy ? "در حال ورود…" : "ورود"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
