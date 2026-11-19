'use client';
/**
 * Stale-while-revalidate cache for the whole dashboard (SWR).
 * - Every GET is cached in memory and persisted to localStorage, so pages render instantly with the
 *   last known data (also after a reload) and refresh quietly in the background.
 * - Heavy/private entries (single resumes, reports) stay in memory only.
 */
import { useEffect, useState } from 'react';
import useSWR, {
  SWRConfig,
  mutate as globalMutate,
  useSWRConfig,
  type ScopedMutator,
  type SWRConfiguration,
} from 'swr';
import { api } from './api';

const STORAGE_KEY = 'ats-cache-v1';
const MEMORY_ONLY = /(\/applications\/|report|^sources$)/;

let cache: Map<string, any> | null = null;
function provider() {
  if (cache) return cache;
  cache = new Map();
  try {
    const saved: [string, unknown][] = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    for (const [k, data] of saved) cache.set(k, { data });
  } catch {
    /* empty or blocked storage */
  }
  const save = () => {
    try {
      const entries = [...cache!.entries()]
        .filter(
          ([k, v]) =>
            typeof k === 'string' &&
            !k.startsWith('$') &&
            !MEMORY_ONLY.test(k) &&
            v?.data !== undefined,
        )
        .map(([k, v]) => [k, v.data]);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-150)));
    } catch {
      /* quota or blocked storage */
    }
  };
  window.addEventListener('beforeunload', save);
  document.addEventListener(
    'visibilitychange',
    () => document.visibilityState === 'hidden' && save(),
  );
  setInterval(save, 10_000);
  return cache;
}

export function CacheProvider({ children }: { children: React.ReactNode }) {
  // render on the client only, so the cached data is there on the very first paint (no loading flash)
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return (
    <SWRConfig
      value={{
        provider,
        fetcher: (key: string) => api(key),
        revalidateOnFocus: true,
        revalidateIfStale: true,
        dedupingInterval: 4_000,
        keepPreviousData: true,
        errorRetryCount: 2,
      }}
    >
      <CaptureMutate />
      {children}
    </SWRConfig>
  );
}

/** Cached GET. `data` is the last known value (possibly stale) while it revalidates. */
export function useApi<T>(key: string | null, opts?: SWRConfiguration<T>) {
  const r = useSWR<T>(key, opts);
  return { ...r, firstLoad: r.data === undefined && !r.error };
}

// SWR's global `mutate` talks to SWR's default cache, not to our custom provider.
// Capture the mutate that belongs to our provider and use that everywhere.
let boundMutate: ScopedMutator | null = null;
function CaptureMutate() {
  boundMutate = useSWRConfig().mutate;
  return null;
}

/** Update or revalidate cached data (same signature as SWR's mutate, bound to the dashboard cache). */
export const mutate: ScopedMutator = ((...args: Parameters<ScopedMutator>) =>
  (boundMutate ?? globalMutate)(...args)) as ScopedMutator;

/** Revalidate one key, or every key that starts with a prefix. */
export function refresh(keyOrPrefix: string, prefix = false) {
  if (!prefix) return mutate(keyOrPrefix);
  return mutate((k) => typeof k === 'string' && k.startsWith(keyOrPrefix));
}

/** Small "updating…" hint shown while cached data is being refreshed. */
export function Updating({ on }: { on: boolean }) {
  return on ? <span className="updating">در حال به‌روزرسانی…</span> : null;
}
