'use client';
import { useEffect, useRef, useState } from 'react';
import { downloadXlsx } from '@/core/ats/infra/xlsx';
import { api, fa } from '../../lib/api';
import { mutate, useApi } from '../../lib/cache';
import Markdown from './Markdown';

export interface ExportTable {
  id: string;
  title: string;
  columns: string[];
  rows: (string | number)[][];
}
export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  exports?: ExportTable[];
  at?: string;
}
export interface Thread {
  id: string;
  title: string;
  updatedAt: string;
  count: number;
  messages: Msg[];
}

const SUGGEST = [
  'سه نفر برتر را مقایسه کن',
  'چرا بیشتر رزومه‌ها رد شدند؟',
  'اکسل افراد قبول و تایید نسبی با تلفن، امتیاز و هشدارها',
  'چه کسی را برای مصاحبه پیشنهاد می‌کنی؟',
];

function ExportCard({ t }: { t: ExportTable }) {
  const [open, setOpen] = useState(false);
  const shown = open ? t.rows : t.rows.slice(0, 4);
  return (
    <div className="export-card">
      <div className="row between">
        <div>
          <b>📊 {t.title}</b>
          <div className="small muted">
            {fa(t.rows.length)} ردیف · {fa(t.columns.length - 1)} ستون
          </div>
        </div>
        <button className="btn sm primary" onClick={() => downloadXlsx(t.title, t.columns, t.rows)}>
          دانلود اکسل
        </button>
      </div>
      {t.rows.length > 0 && (
        <div className="md-table" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                {t.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j}>{typeof v === 'number' ? fa(v) : v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {t.rows.length > 4 && (
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>
          {open ? 'نمایش کمتر' : `نمایش همهٔ ${fa(t.rows.length)} ردیف`}
        </button>
      )}
    </div>
  );
}

/**
 * One conversation. threadId = null means "new conversation": the first message creates it.
 */
export default function ChatView({
  src,
  jobId,
  threadId,
  onThreadChange,
  focusIds = [],
  pending,
  onPendingUsed,
  large,
}: {
  src: string;
  jobId: string;
  threadId: string | null;
  onThreadChange: (id: string) => void;
  focusIds?: string[];
  pending?: { text: string; id?: string } | null;
  onPendingUsed?: () => void;
  large?: boolean;
}) {
  const base = `platforms/${src}/jobs/${jobId}`;
  const q = useApi<Thread>(threadId ? `${base}/threads/${threadId}` : null, {
    revalidateOnFocus: false,
  });
  const [optimistic, setOptimistic] = useState<Msg | null>(null);
  const msgs: Msg[] = [
    ...(threadId ? (q.data?.messages ?? []) : []),
    ...(optimistic ? [optimistic] : []),
  ];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  }, [msgs.length, busy]);

  const send = async (message: string, extraFocus: string[] = []) => {
    if (!message.trim() || busy) return;
    setErr('');
    setBusy(true);
    setOptimistic({ role: 'user', content: message });
    setText('');
    try {
      const t = await api<Thread>(`${base}/chat`, {
        body: { threadId, message, focusIds: [...new Set([...focusIds, ...extraFocus])] },
      });
      await mutate(`${base}/threads/${t.id}`, t, { revalidate: false });
      mutate(`${base}/threads`);
      if (t.id !== threadId) onThreadChange(t.id);
    } catch (e: any) {
      setErr(e.message);
      setText(message);
    } finally {
      setOptimistic(null);
      setBusy(false);
    }
  };

  useEffect(() => {
    if (pending) {
      send(pending.text, pending.id ? [pending.id] : []);
      onPendingUsed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <div className={`chat-view ${large ? 'large' : ''}`}>
      <div className="chat-msgs" ref={box}>
        {!msgs.length && !busy && (
          <div className="stack">
            <div className="small muted">
              دستیار متن آگهی، شرایط، خلاصهٔ همهٔ رزومه‌ها و گفتگوهای دیگر همین آگهی را می‌داند.
              مستقیم بپرسید، یا بخواهید خروجی اکسل بدهد. برای بررسی رزومهٔ کامل، آن را در جدول
              انتخاب کنید یا نام فرد را بنویسید.
            </div>
            <div className="suggest">
              {SUGGEST.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {threadId && q.firstLoad && <div className="skeleton" style={{ height: 80 }} />}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            {m.exports?.map((t) => (
              <ExportCard key={t.id} t={t} />
            ))}
          </div>
        ))}
        {busy && <div className="typing">در حال نوشتن…</div>}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        {focusIds.length > 0 && (
          <div className="small">
            <span className="badge accent">
              {fa(focusIds.length)} رزومهٔ انتخاب‌شده با جزئیات کامل بررسی می‌شود
            </span>
          </div>
        )}
        {err && <div className="error-text">{err}</div>}
        <textarea
          className="textarea"
          rows={large ? 3 : 2}
          value={text}
          placeholder="سؤال یا درخواست گزارش خود را بنویسید…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        <div className="row between">
          <span className="small faint">Enter ارسال · Shift+Enter خط جدید</span>
          <button className="btn primary sm" disabled={busy || !text.trim()}>
            ارسال
          </button>
        </div>
      </form>
    </div>
  );
}
