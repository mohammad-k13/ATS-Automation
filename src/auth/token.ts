import fs from "node:fs";
import { jwtExpiry } from "../sources/jobvision-source";
import { jobvisionLogin } from "./jobvision-login";

const env = process.env;
export const tokenKey = (src: string) => `${src.toUpperCase()}_TOKEN`;
const emailKey = (src: string) => `${src.toUpperCase()}_EMAIL`;
const passKey = (src: string) => `${src.toUpperCase()}_PASSWORD`;

/** Replace (or add) KEY=value in .env and in process.env. */
export function writeEnv(key: string, value: string) {
  const file = ".env";
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join("\n"));
  env[key] = value;
}

export function tokenInfo(src: string) {
  const raw = (env[tokenKey(src)] ?? "").replace(/^Bearer\s+/i, "").trim();
  const exp = raw ? jwtExpiry(raw) : null;
  return { hasToken: !!raw, expiresAt: exp?.toISOString() ?? null, valid: !!exp && exp.getTime() > Date.now() + 5 * 60_000 };
}

export function credentials(src: string) {
  return { email: env[emailKey(src)] ?? "", password: env[passKey(src)] ?? "" };
}
export const hasCredentials = (src: string) => !!(credentials(src).email && credentials(src).password);

export function saveCredentials(src: string, email: string, password?: string) {
  writeEnv(emailKey(src), email.trim());
  if (password) writeEnv(passKey(src), password);
}

// one login at a time per platform
const g = globalThis as unknown as { __atsLogins?: Map<string, Promise<string>> };
const inFlight = () => (g.__atsLogins ??= new Map());

export async function loginAndSave(src: string, opts: { show?: boolean; log?: (s: string) => void } = {}): Promise<string> {
  const running = inFlight().get(src);
  if (running) return running;
  const p = (async () => {
    const { email, password } = credentials(src);
    if (src !== "jobvision" && !src.startsWith("jobvision")) throw new Error(`ورود خودکار فقط برای جاب‌ویژن پیاده‌سازی شده`);
    const token = await jobvisionLogin({ email, password, show: opts.show, log: opts.log });
    writeEnv(tokenKey(src), token);
    return token;
  })().finally(() => inFlight().delete(src));
  inFlight().set(src, p);
  return p;
}

/** If the token is missing/expired (or `force`) and credentials are saved, log in again. Returns true if a valid token is available. */
export async function ensureToken(src: string, opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<boolean> {
  if (!opts.force && tokenInfo(src).valid) return true;
  if (!hasCredentials(src)) return tokenInfo(src).valid;
  await loginAndSave(src, { log: opts.log });
  return true;
}
