/**
 * Rule-based checks on a work history (no AI): gaps, field switches, overlapping jobs, short tenures.
 * Dates are Persian (Jalali) year/month as Jobvision returns them; Gregorian years (> 1700) are converted.
 */

export interface WorkItem {
  title: string;
  company: string;
  category: string | null; // job field, e.g. «مهندسی صنایع / مدیریت تولید»
  startYear: number | null;
  startMonth: number | null;
  endYear: number | null; // null + current = still working
  endMonth: number | null;
  current: boolean;
}

export interface ExperienceOptions {
  gapMonths?: number; // gap between jobs worth an alert
  shortMonths?: number; // a job shorter than this is "short"
  overlapMonths?: number; // overlap between two jobs worth an alert
  now?: { year: number; month: number }; // Persian year/month, for tests
}

const faNum = (n: number) => n.toLocaleString('fa-IR', { useGrouping: false });
const MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

/** Current Persian year/month. */
export function persianNow(d = new Date()): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
  };
}

const toPersianYear = (y: number) => (y > 1700 ? y - 621 : y);
const idx = (y: number, m: number | null) => toPersianYear(y) * 12 + ((m ?? 1) - 1);
const label = (i: number) => `${MONTHS[((i % 12) + 12) % 12]} ${faNum(Math.floor(i / 12))}`;
const span = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return (
    [y && `${faNum(y)} سال`, m && `${faNum(m)} ماه`].filter(Boolean).join(' و ') || 'کمتر از یک ماه'
  );
};

export function analyzeExperience(items: WorkItem[], opts: ExperienceOptions = {}): string[] {
  const gapMin = opts.gapMonths ?? 6;
  const shortMax = opts.shortMonths ?? 12;
  const overlapMin = opts.overlapMonths ?? 3;
  const now = opts.now ?? persianNow();
  const nowIdx = idx(now.year, now.month);

  const jobs = items
    .filter((w) => w.startYear)
    .map((w) => {
      const start = idx(w.startYear!, w.startMonth);
      const end = w.current ? nowIdx : w.endYear ? idx(w.endYear, w.endMonth) : null;
      return { ...w, start, end };
    })
    .sort((a, b) => a.start - b.start);
  if (!jobs.length) return [];

  const alerts: string[] = [];
  const name = (j: (typeof jobs)[number]) =>
    `«${j.title || '-'}${j.company ? ` در ${j.company}` : ''}»`;

  // gaps between jobs (compare with the latest end seen so far, so overlapping jobs do not create fake gaps)
  let coveredUntil = jobs[0].end ?? jobs[0].start;
  let lastJob = jobs[0];
  for (const j of jobs.slice(1)) {
    // the end month was still worked, so the gap starts the month after
    const gap = j.start - coveredUntil - 1;
    if (gap > gapMin)
      alerts.push(
        `فاصلهٔ ${span(gap)} بین ${name(lastJob)} و ${name(j)} (از ${label(coveredUntil)} تا ${label(j.start)})`,
      );
    if ((j.end ?? j.start) >= coveredUntil) {
      coveredUntil = j.end ?? j.start;
      lastJob = j;
    }
  }
  // not working now
  if (!jobs.some((j) => j.current)) {
    const idle = nowIdx - coveredUntil;
    if (idle > gapMin)
      alerts.push(`از ${label(coveredUntil)} (${span(idle)}) سابقهٔ کاری ثبت نشده است`);
  }

  // overlapping jobs
  for (let i = 0; i < jobs.length; i++)
    for (let k = i + 1; k < jobs.length; k++) {
      const a = jobs[i];
      const b = jobs[k];
      if (a.end == null || b.end == null) continue;
      const overlap = Math.min(a.end, b.end) - b.start;
      if (overlap >= overlapMin)
        alerts.push(`دو سابقهٔ همزمان به مدت ${span(overlap)}: ${name(a)} و ${name(b)}`);
    }

  // field switches between consecutive jobs
  const withField = jobs.filter((j) => j.category);
  for (let i = 1; i < withField.length; i++) {
    const prev = withField[i - 1];
    const cur = withField[i];
    if (prev.category !== cur.category)
      alerts.push(
        `تغییر حوزهٔ کاری از «${prev.category}» به «${cur.category}» (${label(cur.start)})`,
      );
  }

  // short tenures (finished jobs only)
  const short = jobs.filter((j) => !j.current && j.end != null && j.end - j.start < shortMax);
  if (short.length >= 2)
    alerts.push(
      `${faNum(short.length)} سابقهٔ کوتاه‌تر از ${span(shortMax)}: ${short.map(name).join('، ')}`,
    );
  else if (short.length === 1)
    alerts.push(`سابقهٔ کوتاه (${span(short[0].end! - short[0].start)}): ${name(short[0])}`);

  return alerts;
}
