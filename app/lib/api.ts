'use client';

export async function api<T = any>(
      path: string,
      opts: { method?: string; body?: unknown } = {},
): Promise<T> {
      const res = await fetch(`/api/${path}`, {
            method: opts.method ?? (opts.body ? 'POST' : 'GET'),
            headers: { 'content-type': 'application/json' },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      // dashboard session expired / not logged in -> go to the login page
      if (res.status === 401 && data?.login && !location.pathname.startsWith('/login')) {
            location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data as T;
}

export const fa = (n: number | null | undefined) =>
      n == null ? '-' : Number(n).toLocaleString('fa-IR');
export const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);
export const faDate = (s: string | null | undefined) =>
      s ? new Date(s).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }) : '-';

export interface Status {
      ai: { provider: string; model: string | null };
      telegram: boolean;
      platforms: {
            name: string;
            type: string;
            token: { hasToken: boolean; expiresAt: string | null; valid: boolean };
            autoLogin: { email: string; hasPassword: boolean };
      }[];
      sourcesError: string | null;
}

export const PLATFORM_FA: Record<string, string> = {
      jobvision: 'جاب‌ویژن',
      jobinja: 'جابینجا',
      samples: 'نمونه‌ها',
};
export const platformName = (n: string) => PLATFORM_FA[n] ?? n;
