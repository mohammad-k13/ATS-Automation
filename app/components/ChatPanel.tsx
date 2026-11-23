'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApi } from '../lib/cache';
import ChatView from './chat/ChatView';
import type { ThreadInfo } from './chat/ThreadList';

/** Compact chat beside the job page: pick a conversation, or open the full conversations page. */
export default function ChatPanel({
      src,
      jobId,
      focusIds,
      pending,
      onPendingUsed,
}: {
      src: string;
      jobId: string;
      focusIds: string[];
      pending: { text: string; id?: string } | null;
      onPendingUsed: () => void;
}) {
      const base = `platforms/${src}/jobs/${jobId}`;
      const threads = useApi<ThreadInfo[]>(`${base}/threads`).data ?? [];
      const storeKey = `ats-thread:${src}:${jobId}`;
      const [threadId, setThreadId] = useState<string | null>(null);
      // remember the last conversation per job; otherwise open the most recent one
      useEffect(() => {
            let saved: string | null = null;
            try {
                  saved = localStorage.getItem(storeKey);
            } catch {
                  /* ignore */
            }
            if (saved && threads.some((t) => t.id === saved)) setThreadId(saved);
            else if (threadId === null && threads[0]) setThreadId(threads[0].id);
            // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [threads.length]);
      const pick = (id: string | null) => {
            setThreadId(id);
            try {
                  id ? localStorage.setItem(storeKey, id) : localStorage.removeItem(storeKey);
            } catch {
                  /* ignore */
            }
      };

      return (
            <aside className="panel chat">
                  <div className="chat-head">
                        <div className="grow" style={{ minWidth: 0 }}>
                              <h2>دستیار استخدام</h2>
                              <select
                                    className="input thread-select"
                                    value={threadId ?? ''}
                                    onChange={(e) => pick(e.target.value || null)}
                              >
                                    <option value="">+ گفتگوی جدید</option>
                                    {threads.map((t) => (
                                          <option key={t.id} value={t.id}>
                                                {t.title}
                                          </option>
                                    ))}
                              </select>
                        </div>
                        <Link
                              className="btn sm"
                              href={`/p/${src}/jobs/${jobId}/chat${threadId ? `?thread=${threadId}` : ''}`}
                              title="صفحهٔ کامل گفتگوها"
                        >
                              ↗ همهٔ گفتگوها
                        </Link>
                  </div>
                  <ChatView
                        src={src}
                        jobId={jobId}
                        threadId={threadId}
                        onThreadChange={pick}
                        focusIds={focusIds}
                        pending={pending}
                        onPendingUsed={onPendingUsed}
                  />
            </aside>
      );
}
