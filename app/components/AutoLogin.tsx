"use client";
import { useState } from "react";
import { api, type Status } from "../lib/api";
import TokenButton from "./TokenDialog";

type P = Status["platforms"][number];

export default function AutoLogin({ p, onChange }: { p: P; onChange: () => void }) {
  const [email, setEmail] = useState(p.autoLogin.email);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "login">("");
  const [msg, setMsg] = useState<{ cls: string; text: string } | null>(null);

  const saveAndLogin = async () => {
    setMsg(null);
    try {
      setBusy("save");
      if (email !== p.autoLogin.email || password) await api(`platforms/${p.name}/credentials`, { method: "PUT", body: { email, password } });
      setPassword("");
      setBusy("login");
      await api(`platforms/${p.name}/login`, { body: { show } });
      setMsg({ cls: "ok", text: "ورود موفق بود و توکن جدید ذخیره شد. از این به بعد هر وقت توکن منقضی شود، سامانه خودش دوباره وارد می‌شود." });
      window.dispatchEvent(new Event("ats:status"));
      onChange();
    } catch (e: any) {
      setMsg({ cls: "bad", text: e.message });
      onChange();
    } finally {
      setBusy("");
    }
  };

  const canSubmit = email.trim() && (password || p.autoLogin.hasPassword) && !busy;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="grid2">
        <label className="field">
          <span>ایمیل یا نام کاربری</span>
          <input className="input ltr" style={{ textAlign: "left" }} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
        <label className="field">
          <span>رمز عبور</span>
          <input className="input ltr" style={{ textAlign: "left" }} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder={p.autoLogin.hasPassword ? "ذخیره شده — برای تغییر وارد کنید" : ""} />
        </label>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={!canSubmit} onClick={saveAndLogin}>
          {busy === "save" ? "در حال ذخیره…" : busy === "login" ? "در حال ورود به سایت…" : "ذخیره و ورود"}
        </button>
        <label className="row small muted" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> نمایش مرورگر (اگر کپچا یا کد پیامکی دارد)
        </label>
        <span className="grow" />
        <TokenButton src={p.name} onSaved={onChange} />
      </div>
      {busy === "login" && <div className="small muted">مرورگر در پس‌زمینه وارد سایت می‌شود؛ معمولاً ۱۰ تا ۳۰ ثانیه طول می‌کشد.</div>}
      {msg && <div className={`notice ${msg.cls}`} style={{ whiteSpace: "pre-wrap" }}>{msg.text}</div>}
      <div className="small faint">ایمیل و رمز فقط روی همین کامپیوتر در فایل <span className="ltr">.env</span> ذخیره می‌شوند و برای ورود خودکار هر چند ساعت یک بار استفاده می‌شوند.</div>
    </div>
  );
}
