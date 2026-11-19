import { z } from 'zod';
import { httpFetch } from '../../../shared/http';
import type { Application, ResumeFile, Source } from '../../domain/types';
import { sleep } from '../../../shared/util';
import { analyzeExperience, type WorkItem } from '../../domain/experience';
import { AuthError } from './http-source';

/**
 * Jobvision employer panel (employerapi.jobvision.ir). READ-ONLY: never calls ViewCvFor3Seconds,
 * status changes or anything else that marks a CV as seen.
 *
 * Flow per job post:
 *   GetJobHeaderData                 -> job title
 *   GetFilteredApplicationsIds       -> application ids with the given status (10 = undecided)
 *   GetListOfApplicationsSummary     -> summaries, 10 ids per call
 *   GetApplicationDetails2           -> full structured CV (turned into text for scoring)
 *   fileapi Files/Download?FileId=   -> uploaded PDF (only for accepted candidates, to attach)
 */
export const JobvisionSourceConfig = z.object({
  name: z.string().default('jobvision'),
  type: z.literal('jobvision'),
  enabled: z.boolean().default(true),
  token: z.string(),
  /** Jobs to pull in CLI/scheduled runs. The dashboard picks jobs itself, so this can be empty there. */
  jobPostIds: z.array(z.coerce.number()).default([]),
  /** 10 = undecided (تعیین وضعیت نشده). Others from BaseData/GetListOfApplicationStatuses. */
  status: z.number().default(10),
  maxPerJob: z.number().default(200),
  delayMs: z.number().default(1200),
  apiBase: z.string().default('https://employerapi.jobvision.ir/api/v1.0'),
  fileBase: z.string().default('https://fileapi.jobvision.ir/api/v1.0'),
  panelBase: z.string().default('https://employer.jobvision.ir'),
  /** Public job page, {id} = job post id. Used to read the published ad text. */
  publicJobUrl: z.string().default('https://jobvision.ir/jobs/{id}'),
  proxy: z.string().optional(),
});
export type JobvisionSourceConfig = z.infer<typeof JobvisionSourceConfig>;

const Envelope = z.object({
  isSuccess: z.boolean(),
  message: z.string().nullable().optional(),
  data: z.any().optional(),
});

/** Decode JWT exp without verifying (just to warn before calling). */
export function jwtExpiry(token: string): Date | null {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof p.exp === 'number' ? new Date(p.exp * 1000) : null;
  } catch {
    return null;
  }
}

const t = (v: any): string =>
  (v == null ? '' : typeof v === 'string' ? v : (v.titleFa ?? v.title ?? v.titleEn ?? ''))
    .toString()
    .trim();

/** Turn GetApplicationDetails2.data into a readable resume. Leaves out age, gender, marital status and contact info. */
export function cvToText(d: any): string {
  const cv = d?.cvDetail ?? {};
  const b = cv.basicInfo ?? {};
  const L: string[] = [];
  L.push(`نام: ${t(b.fullName)}`);
  if (cv.aboutMe) L.push(`دربارهٔ من: ${t(cv.aboutMe)}`);
  if (cv.totalWorkExperience != null) L.push(`سابقهٔ کار کل: ${cv.totalWorkExperience} سال`);
  if (b.residenceCity)
    L.push(`شهر: ${t(b.residenceCity)}${b.residenceProvince ? `, ${t(b.residenceProvince)}` : ''}`);
  if (b.militaryServiceStatus) L.push(`وضعیت خدمت: ${t(b.militaryServiceStatus)}`);
  if (b.requestedSalaryRange) L.push(`حقوق درخواستی: ${t(b.requestedSalaryRange)}`);

  const work = cv.listOfWorkExperiences ?? [];
  if (work.length) {
    L.push('\nسوابق کاری:');
    for (const w of work) {
      L.push(
        `- ${t(w.roleTitle)} در ${t(w.companyTitle)} (${t(w.dateRange)}${w.duration ? `, ${t(w.duration)}` : ''})` +
          [
            w.seniorityLevel && `سطح: ${t(w.seniorityLevel)}`,
            w.industry && `صنعت: ${t(w.industry)}`,
            w.city && `شهر: ${t(w.city)}`,
          ]
            .filter(Boolean)
            .map((x) => `; ${x}`)
            .join(''),
      );
      if (w.description) L.push(`  ${t(w.description)}`);
    }
  }
  const cats = cv.listOfTotalWorkExperiencesInJobCategories ?? [];
  if (cats.length)
    L.push(
      '\nسابقه به تفکیک حوزه:',
      ...cats.map(
        (c: any) =>
          `- ${t(c.jobCategory)}: ${c.totalWorkExperiencesInJobCategory ?? c.experienceYears} سال`,
      ),
    );

  const edu = cv.listOfEducations ?? [];
  if (edu.length) {
    L.push('\nتحصیلات:');
    for (const e of edu)
      L.push(
        `- ${t(e.educationLevel)} ${t(e.educationField)}, ${t(e.universityName)} (${e.startYear ?? '?'}-${e.isStillStudying ? 'اکنون' : (e.finishYear ?? '?')})${e.gpa ? `، معدل ${e.gpa}` : ''}`,
      );
  }
  const sw = cv.listOfSoftwareSkills ?? [];
  if (sw.length)
    L.push(
      '\nمهارت‌های نرم‌افزاری:',
      sw.map((s: any) => `${t(s.software)} (${t(s.skillLevel)})`).join(', '),
    );
  const custom = cv.listOfCustomSkills ?? [];
  if (custom.length) L.push('\nسایر مهارت‌ها:', custom.map((s: any) => t(s)).join(', '));
  const lang = cv.listOfLanguageSkills ?? [];
  if (lang.length)
    L.push('\nزبان‌ها:', lang.map((s: any) => `${t(s.language)} (${t(s.skillLevel)})`).join(', '));
  const courses = cv.listOfCourses ?? [];
  if (courses.length)
    L.push(
      '\nدوره‌ها:',
      ...courses.map((c: any) =>
        `- ${t(c.title ?? c.courseTitle ?? c.name)} ${t(c.institute ?? c.instituteName)}`.trim(),
      ),
    );
  const projects = cv.listOfAcademicExperiencesAndProjects ?? [];
  if (projects.length)
    L.push(
      '\nپروژه‌ها:',
      ...projects.map((p: any) => `- ${t(p.title)} ${t(p.description)}`.trim()),
    );
  const awards = cv.listOfAwardsAndHonors ?? [];
  if (awards.length) L.push('\nافتخارات:', ...awards.map((p: any) => `- ${t(p.title)}`));
  const cover = d?.coverLetter ?? d?.applicationCoverLetterSummary;
  if (cover)
    L.push(
      '\nنامهٔ همراه:',
      typeof cover === 'string' ? cover : t(cover.text ?? cover.content ?? JSON.stringify(cover)),
    );
  return L.join('\n');
}

export interface JobPost {
  id: string;
  title: string;
  city: string | null;
  status: string | null;
  expireDate: string | null;
  timeDescription: string | null;
  submitter: string | null;
}

const stripHtml = (h: string) =>
  h
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

/** Pull the job ad out of a public job page (JSON-LD JobPosting first). */
export function extractJobAd(html: string): string {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] ?? [data]);
      const jp = items.find((x: any) => String(x?.['@type']).includes('JobPosting'));
      if (jp?.description) {
        const parts = [
          jp.title && `عنوان: ${jp.title}`,
          jp.hiringOrganization?.name && `شرکت: ${jp.hiringOrganization.name}`,
          jp.employmentType && `نوع همکاری: ${[].concat(jp.employmentType).join('، ')}`,
          stripHtml(String(jp.description)),
        ];
        return parts.filter(Boolean).join('\n');
      }
    } catch {
      /* ignore broken JSON-LD */
    }
  }
  const meta = html.match(
    /<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)/i,
  )?.[1];
  if (meta && meta.length > 120) return stripHtml(meta);
  throw new Error('متن آگهی در صفحهٔ عمومی پیدا نشد');
}

export const fileAuthMemo: { way?: string } = ((globalThis as any).__atsFileAuth ??= {});
const fileIdOf = (url?: string | null) =>
  url ? new URL(url, 'https://x').searchParams.get('FileId') : null;
const isPdf = (d: Uint8Array) => d[0] === 0x25 && d[1] === 0x50 && d[2] === 0x44 && d[3] === 0x46;
function extOf(d: Uint8Array, ct: string, cd: string | null) {
  const named = cd?.match(/filename\*?=(?:UTF-8'')?"?[^";]*?(\.[a-z0-9]{2,5})"?(?:;|$)/i)?.[1];
  if (named) return named.toLowerCase();
  if (isPdf(d) || ct.includes('pdf')) return '.pdf';
  if (d[0] === 0x50 && d[1] === 0x4b) return '.docx';
  if (d[0] === 0xff && d[1] === 0xd8) return '.jpg';
  if (d[0] === 0x89 && d[1] === 0x50) return '.png';
  if (ct.includes('msword')) return '.doc';
  return '.pdf';
}

/** Work history from GetApplicationDetails2 in a neutral shape for the experience checks. */
export function workItems(d: any): WorkItem[] {
  const num = (v: any) => (v == null || v === '' ? null : Number(v));
  return (d?.cvDetail?.listOfWorkExperiences ?? []).map((w: any) => ({
    title: t(w.roleTitle),
    company: t(w.companyTitle),
    category: t(w.jobCategory) || null,
    startYear: num(w.startYear),
    startMonth: num(w.startMonth),
    endYear: num(w.finishYear),
    endMonth: num(w.finishMonth),
    current: !!w.isStillWorking,
  }));
}

export class JobvisionSource implements Source {
  name: string;
  private token: string;
  private titles = new Map<number, string>();
  /** If set, overrides cfg.jobPostIds for the next listApplications() (used by the dashboard). */
  onlyJobs?: number[];

  constructor(private cfg: JobvisionSourceConfig) {
    this.name = cfg.name;
    this.token = cfg.token.replace(/^Bearer\s+/i, '').trim();
  }

  private checkToken() {
    if (!this.token)
      throw new AuthError(
        `${this.name}: JOBVISION_TOKEN is empty. Copy the Authorization header (without "Bearer ") from DevTools into .env`,
      );
    if (/[^\x21-\x7e]/.test(this.token))
      throw new AuthError(
        `${this.name}: JOBVISION_TOKEN contains invalid characters (e.g. "…" or spaces) - it was copied truncated. In DevTools turn on "Raw" for the request headers and copy the full Authorization value.`,
      );
    if (this.token.split('.').length !== 3)
      throw new AuthError(
        `${this.name}: JOBVISION_TOKEN does not look like a full token (expected 3 parts separated by dots). Copy the full Authorization value again.`,
      );
    const exp = jwtExpiry(this.token);
    if (exp && exp.getTime() < Date.now() + 60_000)
      throw new AuthError(
        `${this.name}: token expired at ${exp.toISOString()}. Log in to employer.jobvision.ir and paste a fresh token into .env`,
      );
  }

  private async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const url = `${this.cfg.apiBase}${path}`;
    const res = await httpFetch(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json, text/plain, */*',
          Origin: this.cfg.panelBase,
          Referer: `${this.cfg.panelBase}/`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.cfg.proxy,
    );
    if (res.status === 401 || res.status === 403)
      throw new AuthError(
        `${this.name}: ${res.status} on ${path} - token expired or invalid, paste a fresh one into .env`,
      );
    const text = await res.text();
    if (!res.ok)
      throw new Error(`${this.name}: HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
    const env = Envelope.safeParse(JSON.parse(text));
    if (!env.success)
      throw new Error(
        `${this.name}: unexpected response shape on ${path} (API changed?): ${text.slice(0, 200)}`,
      );
    if (!env.data.isSuccess)
      throw new Error(`${this.name}: ${path} failed: ${env.data.message ?? 'unknown error'}`);
    await sleep(this.cfg.delayMs);
    return env.data.data;
  }

  async listApplications(): Promise<Application[]> {
    this.checkToken();
    const out: Application[] = [];
    const jobIds = this.onlyJobs ?? this.cfg.jobPostIds;
    if (!jobIds.length) throw new Error(`${this.name}: no jobPostIds configured`);
    for (const jobPostId of jobIds) {
      const header = await this.api('GET', `/jobpost/GetJobHeaderData?jobPostId=${jobPostId}`);
      const jobTitle = t(header?.jobPostTitle) || `Job ${jobPostId}`;
      this.titles.set(jobPostId, jobTitle);

      const ids: number[] =
        (await this.api('POST', '/JobPostApplication/GetFilteredApplicationsIds', {
          status: this.cfg.status,
          sortBy: 0,
          jobPostId,
        })) ?? [];
      const wanted = ids.slice(0, this.cfg.maxPerJob);
      for (let i = 0; i < wanted.length; i += 10) {
        const batch = wanted.slice(i, i + 10);
        const data = await this.api('POST', '/JobPostApplication/GetListOfApplicationsSummary', {
          jobPostId,
          listOfApplicationsId: batch,
        });
        for (const s of data?.listOfApplicationSummaries ?? [])
          out.push(this.mapSummary(s, jobPostId, jobTitle));
      }
    }
    return out;
  }

  /** Active job posts (statusId 1) from the employer panel. */
  async listJobs(statusId = 1): Promise<JobPost[]> {
    this.checkToken();
    const out: JobPost[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.api('POST', '/JobPost/GetListOfJobPosts', {
        statusId,
        keyword: '',
        pageNumber: page,
        pageSize: 50,
      });
      const items: any[] = data?.listOfJobPostSummaries ?? [];
      for (const j of items)
        out.push({
          id: String(j.id),
          title: t(j.title),
          city: t(j.cityName) || null,
          status: t(j.status) || null,
          expireDate: j.expireDate ?? null,
          timeDescription: t(j.timeDescription) || null,
          submitter: t(j.fullName) || null,
        });
      if (items.length < 50) break;
    }
    return out;
  }

  /** Counters shown in the panel for one job (new, undecided, rejected, total). */
  async jobCounts(
    jobPostId: string,
  ): Promise<{ total: number; undecided: number; rejected: number; newCount: number }> {
    const d = await this.api(
      'GET',
      `/JobPostApplication/GetApplicationManagementHeader?jobPostId=${jobPostId}`,
    );
    return {
      total: d?.totalCount ?? 0,
      undecided: d?.unsetStatusCount ?? 0,
      rejected: d?.rejectedCount ?? 0,
      newCount: d?.newResumeCount ?? 0,
    };
  }

  /**
   * Text of the published job ad. Reads the public job page and takes the JobPosting JSON-LD
   * (what search engines read), falling back to the page's meta description / visible text.
   */
  async getJobAd(jobPostId: string): Promise<string> {
    const url = this.cfg.publicJobUrl.replace('{id}', encodeURIComponent(jobPostId));
    const res = await httpFetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
          'Accept-Language': 'fa,en;q=0.8',
        },
      },
      this.cfg.proxy,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return extractJobAd(await res.text());
  }

  mapSummary(s: any, jobPostId: number, jobTitle: string): Application {
    const cv = s.cvSummary ?? {};
    const b = cv.basicInfo ?? {};
    const files = cv.cvFiles ?? {};
    return {
      source: this.name,
      id: String(s.applicationId),
      name: t(b.fullName) || `Applicant ${s.applicationId}`,
      jobId: String(jobPostId),
      jobTitle,
      appliedAt: s.applicationTime,
      profileUrl: `${this.cfg.panelBase}/jobs/${jobPostId}/applications/${s.applicationId}/jobvision-profile`,
      resumeUrl: files.hasPersonalCv && files.personalCvPdfUrl ? files.personalCvPdfUrl : undefined,
      phone: cv.contactData?.mobileNumber || cv.contactData?.phoneNumber || undefined,
      extra: {
        resumeType: files.hasPersonalCv ? 'فایل رزومهٔ شخصی' : 'پروفایل جاب‌ویژن',
        cvId: cv.cvId ?? cv.id ?? s.userId ?? null,
        personalCvFileId: files.hasPersonalCv ? fileIdOf(files.personalCvPdfUrl) : null,
        jobvisionMatchScore: s.matchingScore ?? null,
        totalWorkExperienceYears: cv.totalWorkExperience ?? null,
        city: t(b.residenceCity) || null,
        requestedSalary: t(b.requestedSalaryRange) || null,
        lastJob: t(cv.lastWorkExperienceTitle) || null,
        lastEducation: t(cv.lastEducationTitle) || null,
      },
      raw: s,
    };
  }

  async getResumeText(app: Application): Promise<string> {
    const d = await this.api(
      'GET',
      `/JobPostApplication/GetApplicationDetails2?applicationId=${app.id}&cvlang=1`,
    );
    // Fill the PDF link from details if the summary did not have it
    const f = d?.cvDetail?.cvFiles;
    if (!app.resumeUrl && f?.hasPersonalCv)
      app.resumeUrl =
        f.personalCvPdfUrl ||
        (f.personalCvFileId
          ? `${this.cfg.fileBase}/Files/Download?FileId=${f.personalCvFileId}`
          : undefined);
    // rule-based work-history checks: shown as alerts and given to the AI scorer
    app.extra = { ...(app.extra ?? {}), experienceAlerts: analyzeExperience(workItems(d)) };
    return cvToText(d);
  }

  // ---------------------------------------------------------------- files & status (dashboard)
  private v2Base() {
    return this.cfg.apiBase.replace(/\/v1\.0\/?$/, '/v2.0');
  }

  /** The Jobvision-generated PDF of the candidate's profile (what the panel's «دانلود رزومه» gives). */
  async downloadJobvisionCv(app: Application): Promise<ResumeFile> {
    this.checkToken();
    let cvId = (app.extra?.cvId as number | undefined) ?? undefined;
    if (!cvId) {
      const d = await this.api(
        'GET',
        `/JobPostApplication/GetApplicationDetails2?applicationId=${app.id}&cvlang=1`,
      );
      cvId = d?.cvDetail?.cvId;
    }
    if (!cvId) throw new Error('شناسهٔ رزومه (cvId) پیدا نشد');
    const res = await httpFetch(
      `${this.v2Base()}/Cv/DownloadJvCV_v2`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          Origin: this.cfg.panelBase,
          Referer: `${this.cfg.panelBase}/`,
        },
        body: JSON.stringify({ cvId, jobPostId: Number(app.jobId), language: 2, medium: 3 }),
      },
      this.cfg.proxy,
      120_000,
    );
    if (res.status === 401 || res.status === 403)
      throw new AuthError(`${this.name}: ${res.status} downloading Jobvision CV`);
    if (!res.ok) throw new Error(`دانلود رزومهٔ جاب‌ویژن ناموفق بود (HTTP ${res.status})`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(data)) throw new Error('پاسخ جاب‌ویژن فایل PDF نبود');
    return { data, filename: 'رزومه جاب‌ویژن.pdf', contentType: 'application/pdf' };
  }

  /**
   * The file the candidate uploaded. The panel only gives a plain link, so try the ways it may be
   * authorised (none / bearer header / token in the link) and remember the one that works.
   */
  /** Where the panel shows this candidate and the plain link to their uploaded file. */
  attachmentLinks(app: Application): {
    profileUrl: string;
    fileUrl: string | null;
    panelBase: string;
  } {
    const fileId =
      (app.extra?.personalCvFileId as number | string | undefined) ?? fileIdOf(app.resumeUrl);
    return {
      profileUrl:
        app.profileUrl ||
        `${this.cfg.panelBase}/jobs/${app.jobId}/applications/${app.id}/jobvision-profile`,
      fileUrl: fileId
        ? `${this.cfg.fileBase}/Files/Download?FileId=${encodeURIComponent(String(fileId))}`
        : null,
      panelBase: this.cfg.panelBase,
    };
  }

  async downloadAttachedCv(app: Application): Promise<ResumeFile | null> {
    const url = this.attachmentLinks(app).fileUrl;
    if (!url) return null;
    const cookie = this.cookieHeader(url);
    const ways: Record<string, () => Promise<Response>> = {
      'cookie+bearer': () =>
        httpFetch(
          url,
          {
            headers: {
              Cookie: cookie,
              Authorization: `Bearer ${this.token}`,
              Referer: `${this.cfg.panelBase}/`,
            },
          },
          this.cfg.proxy,
          120_000,
        ) as any,
      cookie: () =>
        httpFetch(
          url,
          { headers: { Cookie: cookie, Referer: `${this.cfg.panelBase}/` } },
          this.cfg.proxy,
          120_000,
        ) as any,
      bearer: () =>
        httpFetch(
          url,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              Referer: `${this.cfg.panelBase}/`,
              Origin: this.cfg.panelBase,
            },
          },
          this.cfg.proxy,
          120_000,
        ) as any,
      none: () =>
        httpFetch(
          url,
          { headers: { Referer: `${this.cfg.panelBase}/` } },
          this.cfg.proxy,
          120_000,
        ) as any,
      query: () =>
        httpFetch(
          `${url}&access_token=${encodeURIComponent(this.token)}`,
          { headers: { Referer: `${this.cfg.panelBase}/` } },
          this.cfg.proxy,
          120_000,
        ) as any,
    };
    const order = [
      fileAuthMemo.way,
      ...(cookie ? ['cookie+bearer', 'cookie'] : []),
      'bearer',
      'none',
      'query',
    ].filter(
      (w, i, a): w is string => !!w && a.indexOf(w) === i && (!!cookie || !w.startsWith('cookie')),
    );
    const tried: string[] = [];
    for (const way of order) {
      const res = await ways[way]();
      const data = new Uint8Array(await res.arrayBuffer());
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      const looksLikeFile =
        res.ok && data.length > 200 && !ct.includes('json') && !ct.includes('text/html');
      if (looksLikeFile) {
        fileAuthMemo.way = way;
        return {
          data,
          filename: `رزومه پیوست${extOf(data, ct, res.headers.get('content-disposition'))}`,
          contentType: ct || 'application/octet-stream',
        };
      }
      tried.push(`${way}:${res.status}`);
    }
    throw new Error(`دانلود فایل پیوست ناموفق بود (${tried.join('، ')})`);
  }

  /** Cookies saved by the last browser login (see auth/token.ts), as a Cookie header for this URL. */
  private cookieHeader(url: string): string {
    let list: { name: string; value: string; domain: string }[] = [];
    try {
      list = JSON.parse(process.env[`${this.name.toUpperCase()}_COOKIES`] || '[]');
    } catch {
      return '';
    }
    const host = new URL(url).hostname;
    return list
      .filter((c) => {
        const d = c.domain.replace(/^\./, '');
        return host === d || host.endsWith(`.${d}`);
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** Change the application status on Jobvision: 5 = رد شده، 4 = تایید اولیه، 6 = در حال بررسی */
  async changeStatus(
    jobPostId: string,
    apps: { id: string; aiScore?: number | null }[],
    newStatus: 4 | 5 | 6,
  ) {
    this.checkToken();
    await this.api('POST', '/JobPostApplication/ChangeStatus', {
      jobPostId: Number(jobPostId),
      listOfApplicationIds: apps.map((a) => Number(a.id)),
      listOfApplicationIdsWithIndexAndScore: apps.map((a, index) => ({
        applicationId: Number(a.id),
        aIScore: a.aiScore ?? 0,
        index,
      })),
      newStatus,
      didActionOnCard: false,
      sortType: 0,
    });
  }

  async downloadResume(app: Application): Promise<ResumeFile | null> {
    if (!app.resumeUrl) return null;
    const res = await httpFetch(
      app.resumeUrl,
      { headers: { Authorization: `Bearer ${this.token}`, Referer: `${this.cfg.panelBase}/` } },
      this.cfg.proxy,
    );
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} downloading PDF`);
    const ct = res.headers.get('content-type') ?? 'application/pdf';
    const safe = app.name.replace(/[\\/:*?"<>|]+/g, '').trim() || app.id;
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      filename: `${safe} - ${app.jobTitle ?? 'resume'}.pdf`,
      contentType: ct,
    };
  }
}
