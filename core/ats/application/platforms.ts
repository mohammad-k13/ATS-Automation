/** Platform credentials/tokens, manual login (CLI) and the remote-browser login flow used by the dashboard. */
import { aiInfo } from '../infra/ai';
import * as remote from '../infra/auth/remote-login';
import {
  credentials,
  hasCredentials,
  loginAndSave,
  saveCookies,
  savedCookies,
  saveCredentials,
  tokenInfo,
  tokenKey,
  writeEnv,
} from '../infra/auth/token';
import { JobvisionSource } from '../infra/sources/jobvision-source';
import { jobvision, sources, UserError } from './state';

export { tokenInfo };

const env = process.env;

export function status() {
  let platforms: { name: string; type: string; token: ReturnType<typeof tokenInfo> }[] = [];
  let sourcesError: string | null = null;
  try {
    platforms = sources().map((s) => ({
      name: s.name,
      type: s instanceof JobvisionSource ? 'jobvision' : 'other',
      token: tokenInfo(s.name),
      autoLogin: { email: credentials(s.name).email, hasPassword: !!credentials(s.name).password },
    }));
  } catch (e) {
    sourcesError = e instanceof Error ? e.message : String(e);
  }
  return {
    ai: aiInfo(),
    telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    platforms,
    sourcesError,
  };
}

export function setCredentials(src: string, email: string, password?: string) {
  if (!email.trim()) throw new UserError('ایمیل خالی است');
  saveCredentials(src, email, password || undefined);
  return { email: credentials(src).email, hasPassword: !!credentials(src).password };
}

/** Log in with the saved email/password and store the new token. */
export async function loginNow(src: string, show = false) {
  if (!hasCredentials(src)) throw new UserError('اول ایمیل و رمز عبور را ذخیره کنید');
  const log: string[] = [];
  try {
    await loginAndSave(src, { show, log: (l) => log.push(l) });
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 502);
  }
  return { ...tokenInfo(src), log };
}

// ---------- manual login from the dashboard (login page with a captcha) ----------
const remoteCall = async <T>(f: () => Promise<T>): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    throw new UserError(e instanceof Error ? e.message : String(e), 409);
  }
};
export const remoteLogin = {
  start: (src: string) => {
    jobvision(src);
    return remoteCall(() =>
      remote.startRemoteLogin({
        src,
        email: credentials(src).email,
        cookies: savedCookies(src),
        onDone: (token, cookies) => {
          writeEnv(tokenKey(src), token);
          saveCookies(src, cookies);
        },
      }),
    );
  },
  status: (src: string) => ({ ...remote.status(src), token: tokenInfo(src) }),
  shot: (src: string) => remoteCall(() => remote.screenshot(src)),
  click: (src: string, x: number, y: number) =>
    remoteCall(() => remote.click(src, Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))),
  type: (src: string, text: string) =>
    remoteCall(() => remote.type(src, String(text).slice(0, 200))),
  key: (src: string, key: string) => remoteCall(() => remote.press(src, key)),
  cancel: (src: string) => remote.cancel(src),
};

export function setToken(src: string, token: string) {
  const tok = token.trim();
  if (!tok) throw new UserError('توکن خالی است');
  if (/[^\x21-\x7e ]/.test(tok))
    throw new UserError(
      'توکن کاراکتر نامعتبر دارد (مثلاً «…»). احتمالاً ناقص کپی شده؛ مقدار کامل را کپی کنید.',
    );
  const raw = tok.replace(/^Bearer\s+/i, '');
  if (raw.split('.').length !== 3)
    throw new UserError(
      'این مقدار شبیه یک توکن کامل نیست (باید ۳ بخش جدا شده با نقطه داشته باشد).',
    );
  writeEnv(tokenKey(src), raw);
  return tokenInfo(src);
}
