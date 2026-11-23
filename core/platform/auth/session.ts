/**
 * Dashboard login for server installs. Disabled when ATS_PASSWORD_HASH is not set (single-user PC).
 * Password hash: scrypt:<salt>:<hash>. Session: signed cookie (HMAC-SHA256 with ATS_SECRET).
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'ats_session';
const DAYS = 14;

export const authEnabled = () => !!process.env.ATS_PASSWORD_HASH;

// "scrypt:<salt>:<hash>" — no "$" so .env variable expansion cannot mangle it
export function hashPassword(password: string): string {
      const salt = randomBytes(16).toString('base64url');
      return `scrypt:${salt}:${scryptSync(password, salt, 32).toString('base64url')}`;
}

export function checkPassword(user: string, password: string): boolean {
      const wantUser = process.env.ATS_USER || 'admin';
      const [kind, salt, hash] = (process.env.ATS_PASSWORD_HASH ?? '').split(':');
      if (kind !== 'scrypt' || !salt || !hash) return false;
      const a = scryptSync(password, salt, 32);
      const b = Buffer.from(hash, 'base64url');
      return user.trim() === wantUser && a.length === b.length && timingSafeEqual(a, b);
}

function secret() {
      const s = process.env.ATS_SECRET;
      if (!s) throw new Error('ATS_SECRET is not set');
      return s;
}
const sign = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

export function makeSession(user: string): string {
      const data = Buffer.from(
            JSON.stringify({ u: user, exp: Date.now() + DAYS * 86_400_000 }),
      ).toString('base64url');
      return `${data}.${sign(data)}`;
}

export function readSession(cookieHeader: string | null): { user: string } | null {
      const raw = cookieHeader
            ?.split(/;\s*/)
            .find((c) => c.startsWith(`${COOKIE}=`))
            ?.slice(COOKIE.length + 1);
      if (!raw) return null;
      const [data, sig] = raw.split('.');
      if (!data || !sig) return null;
      const good = Buffer.from(sign(data));
      const got = Buffer.from(sig);
      if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
      try {
            const p = JSON.parse(Buffer.from(data, 'base64url').toString());
            return p.exp > Date.now() ? { user: p.u } : null;
      } catch {
            return null;
      }
}

export function sessionCookie(value: string, secure: boolean) {
      return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
