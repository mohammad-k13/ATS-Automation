"use client";
import { useEffect, useRef, useState } from "react";
import { api, fa } from "../lib/api";
import { useApi } from "../lib/cache";

type Msg = { role: "user" | "assistant"; content: string };

const SUGGEST = ["سه نفر برتر را مقایسه کن", "چرا بیشتر رزومه‌ها رد شدند؟", "چه کسی را برای مصاحبه پیشنهاد می‌کنی؟", "آیا شرایط آگهی بیش از حد سخت‌گیرانه است؟"];

export default function ChatPanel({ src, jobId, focusIds, pending, onPendingUsed }: { src: string; jobId: string; focusIds: string[]; pending: { text: string; id?: string } | null; onPendingUsed: () => void }) {
  const q = useApi<Msg[]>(`platforms/${src}/jobs/${jobId}/chat`, { revalidateOnFocus: false });
  const msgs = q.data ?? [];
  const setMsgs = (v: Msg[] | ((m: Msg[]) => Msg[])) => q.mutate((old) => (typeof v === "function" ? v(old ?? []) : v), { revalidate: false });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  const send = async (message: string, extraFocus: string[] = []) => {
    if (!message.trim() || busy) return;
    setErr("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: message }]);
    setText("");
    try {
      const r = await api<{ messages: Msg[] }>(`platforms/${src}/jobs/${jobId}/chat`, { body: { message, focusIds: [...new Set([...focusIds, ...extraFocus])] } });
      setMsgs(r.messages);
    } catch (e: any) {
      setErr(e.message);
      setMsgs((m) => m.slice(0, -1));
      setText(message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (pending) {
      send(pending.text, pending.id ? [pending.id] : []);
      onPendingUsed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const clear = async () => {
    if (!confirm("گفتگو پاک شود؟")) return;
    await api(`platforms/${src}/jobs/${jobId}/chat`, { method: "DELETE" });
    setMsgs([]);
  };

  return (
    <aside className="panel chat">
      <div className="chat-head">
        <div>
          <h2>دستیار استخدام</h2>
          <div className="small muted">دربارهٔ آگهی و رزومه‌ها بپرسید</div>
        </div>
        {msgs.length > 0 && <button className="btn sm ghost" onClick={clear}>پاک کردن</button>}
      </div>
      <div className="chat-msgs" ref={box}>
        {!msgs.length && (
          <div className="stack">
            <div className="small muted">دستیار متن آگهی، توضیحات شما، شرایط غربالگری و خلاصهٔ همهٔ رزومه‌ها را از قبل می‌داند. مستقیم بپرسید؛ مثلاً چرا یک نفر رد شده یا چند نفر را مقایسه کنید. برای بررسی رزومهٔ کامل، آن را در جدول انتخاب کنید یا نام فرد را بنویسید.</div>
            <div className="suggest">{SUGGEST.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>{m.content}</div>)}
        {busy && <div className="typing">در حال نوشتن…</div>}
      </div>
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        {focusIds.length > 0 && <div className="small"><span className="badge accent">{fa(focusIds.length)} رزومهٔ انتخاب‌شده با جزئیات کامل بررسی می‌شود</span></div>}
        {err && <div className="error-text">{err}</div>}
        <textarea
          className="textarea"
          rows={2}
          value={text}
          placeholder="سؤال خود را بنویسید…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
        />
        <div className="row between">
          <span className="small faint">Enter ارسال · Shift+Enter خط جدید</span>
          <button className="btn primary sm" disabled={busy || !text.trim()}>ارسال</button>
        </div>
      </form>
    </aside>
  );
}
