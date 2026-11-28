/** The "hiring assistant" chat: per-job conversation threads, with the job + resumes as context. */
import { getChat } from '../infra/ai';
import type { ChatMessage } from '../domain/score';
import type { Row, ThreadRow } from '../infra/db';
import { EXPORT_INSTRUCTIONS, extractExports, type ExportTable } from '../infra/exports';
import { jobContext, jobContextText } from './job-settings';
import { db, parse, STATUS_FA, UserError } from './state';

function candidateLine(r: Row) {
    const res = parse(r.result_json);
    const ex = parse(r.extra_json) ?? {};
    const base = `- ${r.name} | وضعیت: ${STATUS_FA[r.decision] ?? r.decision}${r.score != null ? ` | امتیاز: ${r.score}` : ''} | سابقه: ${ex.totalWorkExperienceYears ?? '?'} سال | آخرین شغل: ${ex.lastJob ?? '-'} | شهر: ${ex.city ?? '-'} | حقوق درخواستی: ${ex.requestedSalary ?? '-'}`;
    if (!res) return base;
    return `${base}\n  خلاصه: ${res.summary}\n  نقاط قوت: ${(res.matched ?? []).join('، ')}\n  نقاط ضعف: ${(res.missing ?? []).join('، ')}${res.redFlags?.length ? `\n  هشدارها: ${res.redFlags.join('، ')}` : ''}`;
}

// ---- conversations (threads). Messages may carry Excel exports built by the server.
export interface ChatMsg {
    role: 'user' | 'assistant';
    content: string;
    exports?: ExportTable[];
    at?: string;
}
const threadOut = (t: ThreadRow) => {
    const messages: ChatMsg[] = JSON.parse(t.messages_json);
    return { id: t.id, title: t.title, updatedAt: t.updated_at, count: messages.length, messages };
};
function ownThread(src: string, jobId: string, id: string) {
    const t = db().getThread(id);
    if (!t || t.source !== src || t.job_id !== jobId) throw new UserError('گفتگو پیدا نشد', 404);
    return t;
}

export function listThreads(src: string, jobId: string) {
    return db()
        .listThreads(src, jobId)
        .map((t) => {
            const { messages, ...rest } = threadOut(t);
            const last = [...messages].reverse().find((m) => m.role === 'assistant');
            return {
                ...rest,
                preview: (last?.content ?? messages[0]?.content ?? '')
                    .replace(/[#*|`>-]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .slice(0, 90),
            };
        });
}
export function getThread(src: string, jobId: string, id: string) {
    return threadOut(ownThread(src, jobId, id));
}
export function createThread(src: string, jobId: string, title?: string) {
    return threadOut(db().createThread(src, jobId, title?.trim() || 'گفتگوی جدید'));
}
export function renameThread(src: string, jobId: string, id: string, title: string) {
    ownThread(src, jobId, id);
    if (!title.trim()) throw new UserError('عنوان خالی است');
    db().saveThread(id, { title: title.trim().slice(0, 80) });
    return getThread(src, jobId, id);
}
export function deleteThread(src: string, jobId: string, id: string) {
    ownThread(src, jobId, id);
    db().deleteThread(id);
    return { ok: true };
}

/** What the AI should know from the job's other conversations (titles + recent turns). */
function otherThreadsText(src: string, jobId: string, exceptId: string | null): string {
    let budget = 10_000;
    const parts: string[] = [];
    for (const t of db()
        .listThreads(src, jobId)
        .filter((x) => x.id !== exceptId)
        .slice(0, 12)) {
        const msgs: ChatMsg[] = JSON.parse(t.messages_json);
        if (!msgs.length) continue;
        const lines = msgs
            .slice(-6)
            .map(
                (m) =>
                    `${m.role === 'user' ? 'کارفرما' : 'دستیار'}: ${m.content.replace(/\s+/g, ' ').slice(0, 350)}${m.exports?.length ? ` [اکسل: ${m.exports.map((e) => e.title).join('، ')}]` : ''}`,
            );
        const block = `### «${t.title}»\n${lines.join('\n')}`;
        if (block.length > budget) break;
        budget -= block.length;
        parts.push(block);
    }
    return parts.join('\n\n');
}

export async function chatInThread(
    src: string,
    jobId: string,
    threadId: string | null,
    message: string,
    focusIds: string[] = [],
) {
    const chat = getChat();
    if (!chat) throw new UserError('هوش مصنوعی تنظیم نشده (OMNIROUTE_* در .env)');
    if (!message.trim()) throw new UserError('پیام خالی است');
    const thread = threadId
        ? ownThread(src, jobId, threadId)
        : db().createThread(src, jobId, message.trim().replace(/\s+/g, ' ').slice(0, 48));
    const history: ChatMsg[] = JSON.parse(thread.messages_json);

    const ctx = await jobContext(src, jobId);
    const rows = ctx.rows;
    // full resumes for selected candidates and anyone named in the message
    const named = rows.filter(
        (r) =>
            focusIds.includes(r.id) || (r.name && r.name.split(/\s+/).some((p) => p.length > 2 && message.includes(p))),
    );
    let budget = 60_000;
    const resumes: string[] = [];
    for (const r of named) {
        if (!r.resume_text || budget <= 0) continue;
        const t = r.resume_text.slice(0, Math.min(12_000, budget));
        budget -= t.length;
        resumes.push(`### رزومهٔ کامل ${r.name} (id ${r.id})\n${t}`);
    }
    const n = (d: string) => rows.filter((r) => r.decision === d).length;
    const scored = rows.filter(
        (r) => r.decision === 'accepted' || r.decision === 'partial' || r.decision === 'rejected',
    );
    const avg = scored.length ? Math.round(scored.reduce((x, r) => x + (r.score ?? 0), 0) / scored.length) : null;
    const others = otherThreadsText(src, jobId, thread.id);

    const system = `تو دستیار استخدام یک کارفرما هستی و دربارهٔ یک آگهی شغلی و رزومه‌های دریافتی آن با او گفتگو می‌کنی.
همهٔ اطلاعات آگهی، خلاصهٔ همهٔ رزومه‌ها و گفتگوهای دیگرِ همین آگهی در ادامه آمده است؛ این‌ها را از قبل می‌دانی، پس از کارفرما نخواه چیزی را دوباره توضیح دهد.
همیشه به فارسی، دقیق و کاربردی جواب بده و از مارک‌داون استفاده کن (تیتر کوتاه، فهرست، **پررنگ**، جدول برای مقایسه). فقط بر اساس همین اطلاعات حرف بزن و اگر چیزی را نمی‌دانی صادقانه بگو.
وقتی می‌پرسد چرا کسی پذیرفته یا رد شده، به نقاط قوت/ضعف، هشدارها و شرایط آگهی استناد کن.
جنسیت، سن، مذهب، قومیت و وضعیت تأهل را در قضاوت دخالت نده.

## آگهی
${jobContextText(ctx)}

## رزومه‌ها (هر خط با [id:...] شروع می‌شود)
تعداد کل: ${rows.length} · قبول: ${n('accepted')} · تایید نسبی: ${n('partial')} · رد: ${n('rejected')} · بررسی‌نشده: ${n('pending')} · خطا: ${n('error')}${avg != null ? ` · میانگین امتیاز: ${avg}` : ''}
${rows
    .slice(0, 200)
    .map((r) => `[id:${r.id}] ${candidateLine(r).replace(/^- /, '')}`)
    .join('\n')}
${resumes.length ? `\n## جزئیات رزومه‌های مورد بحث\n${resumes.join('\n\n')}` : ''}
${others ? `\n## گفتگوهای دیگر کارفرما دربارهٔ همین آگهی (برای آگاهی؛ اگر لازم شد به آن‌ها اشاره کن)\n${others}` : ''}

${EXPORT_INSTRUCTIONS}`;

    const asText = (m: ChatMsg) =>
        m.exports?.length
            ? `${m.content}\n[فایل اکسل ساخته شد: ${m.exports.map((e) => `${e.title} (${e.rows.length} ردیف)`).join('، ')}]`
            : m.content;
    const turns: ChatMessage[] = [
        ...history.slice(-20).map((m) => ({ role: m.role, content: asText(m) })),
        { role: 'user', content: message },
    ];
    const raw = await chat(system, turns, 3000);
    const { text, exports, errors } = extractExports(raw, rows, ctx.meta.unit);
    const answer = [
        text || (exports.length ? 'فایل اکسل آماده است.' : ''),
        errors.length ? `\n> ساخت اکسل ناموفق بود: ${errors.join('؛ ')}` : '',
    ]
        .join('')
        .trim();
    const now = new Date().toISOString();
    const saved: ChatMsg[] = [
        ...history,
        { role: 'user', content: message, at: now },
        { role: 'assistant', content: answer, exports: exports.length ? exports : undefined, at: now },
    ];
    db().saveThread(thread.id, { messages: saved });
    return getThread(src, jobId, thread.id);
}
