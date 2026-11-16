"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ChatView from "../../../../../components/chat/ChatView";
import ThreadList from "../../../../../components/chat/ThreadList";

function ChatPage() {
  const { src, id } = useParams<{ src: string; id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const threadId = search.get("thread");
  const select = (tid: string | null) => {
    try { tid ? localStorage.setItem(`ats-thread:${src}:${id}`, tid) : localStorage.removeItem(`ats-thread:${src}:${id}`); } catch { /* ignore */ }
    router.replace(`/p/${src}/jobs/${id}/chat${tid ? `?thread=${tid}` : ""}`);
  };
  return (
    <div className="chat-page">
      <aside className="panel chat-threads">
        <ThreadList src={src} jobId={id} current={threadId} onSelect={select} />
      </aside>
      <section className="panel chat-main">
        <ChatView key={threadId ?? "new"} src={src} jobId={id} threadId={threadId} onThreadChange={select} large />
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><ChatPage /></Suspense>;
}
