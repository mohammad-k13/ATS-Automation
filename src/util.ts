/** Read a dotted path like "data.items.0.name" from an object. */
export function getPath(obj: unknown, path?: string): unknown {
  if (!path) return undefined;
  if (path === "." || path === "$") return obj;
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Replace ${VAR} with process.env.VAR (empty string if unset). */
export function interpolate<T>(v: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? "") as T;
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env)) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)])) as T;
  return v;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
