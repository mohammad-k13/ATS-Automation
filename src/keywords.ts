/**
 * Persian-aware keyword matching. No imports on purpose: this runs on the server AND in the browser,
 * so it must not pull in server-only packages.
 */

/** Unify Arabic/Persian letter shapes, ZWNJ and digits so matching works on real resumes. */
export function normalize(s: string): string {
  return s
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‏]/g, " ")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .toLowerCase();
}

// Persian word endings a keyword may carry in a resume: نگهبان → نگهبانی/نگهبانان، دوربین → دوربین‌ها
const SUFFIX = "(?:های|هایی|هایم|هایت|هایش|ها|ان|گان|یی|ی|ات|ام|اش|تر|ترین|گری|گر)?";

/** Does `kw` appear in `text`? Tolerates Persian endings and small gaps inside a phrase. */
export function hasKeyword(text: string, kw: string): boolean {
  const t = normalize(text);
  const words = normalize(kw).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // each word may carry a suffix; between the words of a phrase up to two other words may appear
  const body = words.map((w) => esc(w) + SUFFIX).join("(?:[\\s‌]+[\\p{L}\\p{N}]+){0,2}[\\s‌]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "u").test(t);
}

/** Hard-filter words are matched literally, so only short keywords can work there. */
export const MAX_FILTER_WORDS = 4;
export const isFilterKeyword = (s: string) => {
  const w = s.trim().split(/\s+/).filter(Boolean);
  return w.length > 0 && w.length <= MAX_FILTER_WORDS && s.trim().length <= 40 && !/[.،؛:!?]/.test(s);
};
