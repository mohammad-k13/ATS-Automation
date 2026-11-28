import { jwtExpiry } from '../sources/jobvision-source';
import { saveSetting } from '../../../platform/settings-store';
import { loginInBrowser, renewWithCookies, type SavedCookie } from './jobvision-login';

const env = process.env;
export const tokenKey = (src: string) => `${src.toUpperCase()}_TOKEN`;
const emailKey = (src: string) => `${src.toUpperCase()}_EMAIL`;
const passKey = (src: string) => `${src.toUpperCase()}_PASSWORD`;

/** Save a setting (stored exactly as typed in settings.json, see settings-store.ts) and apply it now. */
export function writeEnv(key: string, value: string) {
    saveSetting(key, value);
}

export function tokenInfo(src: string) {
    const raw = (env[tokenKey(src)] ?? '').replace(/^Bearer\s+/i, '').trim();
    const exp = raw ? jwtExpiry(raw) : null;
    return {
        hasToken: !!raw,
        expiresAt: exp?.toISOString() ?? null,
        valid: !!exp && exp.getTime() > Date.now() + 5 * 60_000,
    };
}

export function credentials(src: string) {
    return { email: env[emailKey(src)] ?? '', password: env[passKey(src)] ?? '' };
}
export const hasCredentials = (src: string) => !!(credentials(src).email && credentials(src).password);

export function saveCredentials(src: string, email: string, password?: string) {
    writeEnv(emailKey(src), email.trim());
    if (password) writeEnv(passKey(src), password);
}

// one login at a time per platform
const g = globalThis as unknown as { __atsLogins?: Map<string, Promise<string>> };
const inFlight = () => (g.__atsLogins ??= new Map());

export async function loginAndSave(
    src: string,
    opts: { show?: boolean; log?: (s: string) => void } = {},
): Promise<string> {
    const running = inFlight().get(src);
    if (running) return running;
    const p = (async () => {
        const { email, password } = credentials(src);
        if (src !== 'jobvision' && !src.startsWith('jobvision'))
            throw new Error(`ورود خودکار فقط برای جاب‌ویژن پیاده‌سازی شده`);
        const { token, cookies } = await loginInBrowser({
            email,
            password,
            show: opts.show,
            log: opts.log,
        });
        writeEnv(tokenKey(src), token);
        saveCookies(src, cookies);
        return token;
    })().finally(() => inFlight().delete(src));
    inFlight().set(src, p);
    return p;
}

/** New token from the remembered Jobvision sign-in (no password, no captcha). Returns false if that session ended. */
export async function renewToken(src: string, log?: (s: string) => void): Promise<boolean> {
    const running = inFlight().get(src);
    if (running)
        return running.then(
            () => true,
            () => false,
        );
    const p = (async () => {
        log?.('تمدید توکن با ورود قبلی…');
        const r = await renewWithCookies({ cookies: savedCookies(src) });
        if (!r) throw new Error('ورود قبلی منقضی شده');
        writeEnv(tokenKey(src), r.token);
        saveCookies(src, r.cookies);
        return r.token;
    })().finally(() => inFlight().delete(src));
    inFlight().set(src, p);
    return p.then(
        () => true,
        () => false,
    );
}

/**
 * Make sure there is a valid token: renew it from the remembered sign-in first, then try email/password.
 * Returns true if a valid token is available.
 */
export async function ensureToken(
    src: string,
    opts: { force?: boolean; log?: (s: string) => void } = {},
): Promise<boolean> {
    if (!opts.force && tokenInfo(src).valid) return true;
    if (savedCookies(src).length && (await renewToken(src, opts.log))) return true;
    if (!hasCredentials(src)) return tokenInfo(src).valid;
    await loginAndSave(src, { log: opts.log });
    return true;
}

const cookieKey = (src: string) => `${src.toUpperCase()}_COOKIES`;
/** Cookies from the last browser login (stored as JSON in settings.json). */
export function savedCookies(src: string): SavedCookie[] {
    try {
        return JSON.parse(env[cookieKey(src)] || '[]');
    } catch {
        return [];
    }
}
export function saveCookies(src: string, cookies: SavedCookie[]) {
    if (cookies.length) writeEnv(cookieKey(src), JSON.stringify(cookies));
}
/** Cookie header for a URL, like a browser would send it. */
export function cookieHeader(src: string, url: string): string {
    const host = new URL(url).hostname;
    return savedCookies(src)
        .filter((c) => {
            const d = c.domain.replace(/^\./, '');
            return host === d || host.endsWith(`.${d}`);
        })
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
}
