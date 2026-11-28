/** AI & Telegram settings (stored in .env, editable from the dashboard). */
import { aiInfo, getChat } from '../infra/ai';
import { writeEnv } from '../infra/auth/token';
import { UserError } from './state';

const env = process.env;
const mask = (v?: string) => (v ? `${v.slice(0, 4)}…${v.slice(-4)}` : '');

export function getIntegrations() {
    return {
        ai: {
            provider: (env.AI_PROVIDER || (env.OMNIROUTE_BASE_URL ? 'omniroute' : '')) as string,
            baseUrl: env.OMNIROUTE_BASE_URL ?? '',
            apiKeyMasked: mask(env.OMNIROUTE_API_KEY),
            hasApiKey: !!env.OMNIROUTE_API_KEY,
            model: env.OMNIROUTE_MODEL ?? '',
        },
        telegram: {
            tokenMasked: mask(env.TELEGRAM_BOT_TOKEN),
            hasToken: !!env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID ?? '',
            proxy: env.TELEGRAM_PROXY ?? '',
        },
    };
}

export function saveAiSettings(b: { baseUrl?: string; apiKey?: string; model?: string; enabled?: boolean }) {
    if (b.baseUrl !== undefined) {
        const u = b.baseUrl.trim();
        if (u && !/^https?:\/\//.test(u)) throw new UserError('آدرس باید با http:// یا https:// شروع شود');
        writeEnv('OMNIROUTE_BASE_URL', u);
    }
    if (b.apiKey) writeEnv('OMNIROUTE_API_KEY', b.apiKey.trim());
    if (b.model !== undefined) writeEnv('OMNIROUTE_MODEL', b.model.trim());
    if (b.enabled !== undefined) writeEnv('AI_PROVIDER', b.enabled ? 'omniroute' : 'keyword');
    return getIntegrations();
}

/** List models from the OpenAI-compatible /v1/models endpoint (uses typed values or saved ones). */
export async function listAiModels(b: { baseUrl?: string; apiKey?: string }) {
    const { httpFetch } = await import('../../shared/http');
    let base = (b.baseUrl || env.OMNIROUTE_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!base) throw new UserError('اول آدرس OmniRoute را وارد کنید');
    if (!/\/v\d+$/.test(base)) base += '/v1';
    const key = b.apiKey || env.OMNIROUTE_API_KEY || '';
    let res;
    try {
        res = await httpFetch(
            `${base}/models`,
            { headers: key ? { authorization: `Bearer ${key}` } : {} },
            undefined,
            20_000,
        );
    } catch (e) {
        throw new UserError(`اتصال به ${base} برقرار نشد: ${e instanceof Error ? e.message : e}`, 502);
    }
    const text = await res.text();
    if (!res.ok) throw new UserError(`OmniRoute خطای ${res.status} داد: ${text.slice(0, 200)}`, 502);
    const json = JSON.parse(text);
    const ids: string[] = (json.data ?? json.models ?? [])
        .map((m: any) => (typeof m === 'string' ? m : m.id))
        .filter(Boolean);
    return [...new Set(ids)].sort();
}

export async function testAi() {
    const chat = getChat();
    if (!chat) throw new UserError('هوش مصنوعی تنظیم یا فعال نشده');
    const started = Date.now();
    try {
        const answer = await chat(
            'پاسخ را فقط به فارسی و در یک جمله بده.',
            [{ role: 'user', content: 'سلام، یک جملهٔ کوتاه بگو تا مطمئن شوم وصل هستی.' }],
            100,
        );
        return { ok: true, answer: answer.trim(), ms: Date.now() - started, model: aiInfo().model };
    } catch (e) {
        throw new UserError(e instanceof Error ? e.message : String(e), 502);
    }
}

export function saveTelegramSettings(b: { token?: string; chatId?: string; proxy?: string }) {
    if (b.token) {
        if (!/^\d+:[\w-]{20,}$/.test(b.token.trim()))
            throw new UserError('توکن ربات معتبر نیست (شکل درست: 123456:ABC...)');
        writeEnv('TELEGRAM_BOT_TOKEN', b.token.trim());
    }
    if (b.chatId !== undefined) writeEnv('TELEGRAM_CHAT_ID', b.chatId.trim());
    if (b.proxy !== undefined) writeEnv('TELEGRAM_PROXY', b.proxy.trim());
    return getIntegrations();
}

export async function testTelegram() {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new UserError('توکن ربات و شناسهٔ چت را وارد کنید');
    const { TelegramNotifier } = await import('../infra/telegram');
    try {
        await new TelegramNotifier(
            env.TELEGRAM_BOT_TOKEN,
            env.TELEGRAM_CHAT_ID,
            env.TELEGRAM_PROXY || undefined,
        ).sendText('✅ سامانهٔ جذب به تلگرام وصل شد.');
    } catch (e) {
        throw new UserError(`ارسال ناموفق: ${e instanceof Error ? e.message : e}`, 502);
    }
    return { ok: true };
}
