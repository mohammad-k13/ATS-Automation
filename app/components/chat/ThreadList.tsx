'use client';
import { api, faDate } from '../../lib/api';
import { mutate, useApi } from '../../lib/cache';

export interface ThreadInfo {
  id: string;
  title: string;
  updatedAt: string;
  count: number;
  preview: string;
}

/** Conversations of one job: pick, rename, delete, start a new one. */
export default function ThreadList({
  src,
  jobId,
  current,
  onSelect,
}: {
  src: string;
  jobId: string;
  current: string | null;
  onSelect: (id: string | null) => void;
}) {
  const base = `platforms/${src}/jobs/${jobId}`;
  const q = useApi<ThreadInfo[]>(`${base}/threads`);
  const threads = q.data ?? [];

  const rename = async (t: ThreadInfo) => {
    const title = prompt('عنوان گفتگو:', t.title);
    if (!title?.trim() || title === t.title) return;
    await api(`${base}/threads/${t.id}`, { method: 'PUT', body: { title } });
    mutate(`${base}/threads`);
    mutate(`${base}/threads/${t.id}`);
  };
  const remove = async (t: ThreadInfo) => {
    if (!confirm(`گفتگوی «${t.title}» حذف شود؟`)) return;
    await api(`${base}/threads/${t.id}`, { method: 'DELETE' });
    await mutate(`${base}/threads`);
    if (current === t.id) onSelect(null);
  };

  return (
    <div className="thread-list">
      <button
        className={`thread new ${current === null ? 'on' : ''}`}
        onClick={() => onSelect(null)}
      >
        + گفتگوی جدید
      </button>
      {q.firstLoad && <div className="skeleton" style={{ height: 120 }} />}
      {threads.map((t) => (
        <div
          key={t.id}
          className={`thread ${current === t.id ? 'on' : ''}`}
          onClick={() => onSelect(t.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && onSelect(t.id)}
        >
          <div className="row between" style={{ gap: 4 }}>
            <b className="t-title">{t.title}</b>
            <span className="t-actions" onClick={(e) => e.stopPropagation()}>
              <button title="تغییر نام" onClick={() => rename(t)}>
                ✎
              </button>
              <button title="حذف" onClick={() => remove(t)}>
                ✕
              </button>
            </span>
          </div>
          {t.preview && <div className="t-preview">{t.preview}</div>}
          <div className="t-date">{faDate(t.updatedAt)}</div>
        </div>
      ))}
      {!q.firstLoad && !threads.length && (
        <div className="small faint" style={{ padding: 8 }}>
          هنوز گفتگویی نیست.
        </div>
      )}
    </div>
  );
}
