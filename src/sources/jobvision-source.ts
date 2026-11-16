import { z } from "zod";
import { httpFetch } from "../http";
import type { Application, ResumeFile, Source } from "../types";
import { sleep } from "../util";
import { AuthError } from "./http-source";

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
  name: z.string().default("jobvision"),
  type: z.literal("jobvision"),
  enabled: z.boolean().default(true),
  token: z.string(),
  /** Jobs to pull in CLI/scheduled runs. The dashboard picks jobs itself, so this can be empty there. */
  jobPostIds: z.array(z.coerce.number()).default([]),
  /** 10 = undecided (تعیین وضعیت نشده). Others from BaseData/GetListOfApplicationStatuses. */
  status: z.number().default(10),
  maxPerJob: z.number().default(200),
  delayMs: z.number().default(1200),
  apiBase: z.string().default("https://employerapi.jobvision.ir/api/v1.0"),
  fileBase: z.string().default("https://fileapi.jobvision.ir/api/v1.0"),
  panelBase: z.string().default("https://employer.jobvision.ir"),
  proxy: z.string().optional(),
});
export type JobvisionSourceConfig = z.infer<typeof JobvisionSourceConfig>;

const Envelope = z.object({ isSuccess: z.boolean(), message: z.string().nullable().optional(), data: z.any() });

/** Decode JWT exp without verifying (just to warn before calling). */
export function jwtExpiry(token: string): Date | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof p.exp === "number" ? new Date(p.exp * 1000) : null;
  } catch {
    return null;
  }
}

const t = (v: any): string => (v == null ? "" : typeof v === "string" ? v : (v.titleFa ?? v.title ?? v.titleEn ?? "")).toString().trim();

/** Turn GetApplicationDetails2.data into a readable resume. Leaves out age, gender, marital status and contact info. */
export function cvToText(d: any): string {
  const cv = d?.cvDetail ?? {};
  const b = cv.basicInfo ?? {};
  const L: string[] = [];
  L.push(`نام: ${t(b.fullName)}`);
  if (cv.aboutMe) L.push(`دربارهٔ من: ${t(cv.aboutMe)}`);
  if (cv.totalWorkExperience != null) L.push(`سابقهٔ کار کل: ${cv.totalWorkExperience} سال`);
  if (b.residenceCity) L.push(`شهر: ${t(b.residenceCity)}${b.residenceProvince ? `, ${t(b.residenceProvince)}` : ""}`);
  if (b.militaryServiceStatus) L.push(`وضعیت خدمت: ${t(b.militaryServiceStatus)}`);
  if (b.requestedSalaryRange) L.push(`حقوق درخواستی: ${t(b.requestedSalaryRange)}`);

  const work = cv.listOfWorkExperiences ?? [];
  if (work.length) {
    L.push("\nسوابق کاری:");
    for (const w of work) {
      L.push(`- ${t(w.roleTitle)} در ${t(w.companyTitle)} (${t(w.dateRange)}${w.duration ? `, ${t(w.duration)}` : ""})` +
        [w.seniorityLevel && `سطح: ${t(w.seniorityLevel)}`, w.industry && `صنعت: ${t(w.industry)}`, w.city && `شهر: ${t(w.city)}`].filter(Boolean).map((x) => `; ${x}`).join(""));
      if (w.description) L.push(`  ${t(w.description)}`);
    }
  }
  const cats = cv.listOfTotalWorkExperiencesInJobCategories ?? [];
  if (cats.length) L.push("\nسابقه به تفکیک حوزه:", ...cats.map((c: any) => `- ${t(c.jobCategory)}: ${c.totalWorkExperiencesInJobCategory ?? c.experienceYears} سال`));

  const edu = cv.listOfEducations ?? [];
  if (edu.length) {
    L.push("\nتحصیلات:");
    for (const e of edu)
      L.push(`- ${t(e.educationLevel)} ${t(e.educationField)}, ${t(e.universityName)} (${e.startYear ?? "?"}-${e.isStillStudying ? "اکنون" : e.finishYear ?? "?"})${e.gpa ? `، معدل ${e.gpa}` : ""}`);
  }
  const sw = cv.listOfSoftwareSkills ?? [];
  if (sw.length) L.push("\nمهارت‌های نرم‌افزاری:", sw.map((s: any) => `${t(s.software)} (${t(s.skillLevel)})`).join(", "));
  const custom = cv.listOfCustomSkills ?? [];
  if (custom.length) L.push("\nسایر مهارت‌ها:", custom.map((s: any) => t(s)).join(", "));
  const lang = cv.listOfLanguageSkills ?? [];
  if (lang.length) L.push("\nزبان‌ها:", lang.map((s: any) => `${t(s.language)} (${t(s.skillLevel)})`).join(", "));
  const courses = cv.listOfCourses ?? [];
  if (courses.length) L.push("\nدوره‌ها:", ...courses.map((c: any) => `- ${t(c.title ?? c.courseTitle ?? c.name)} ${t(c.institute ?? c.instituteName)}`.trim()));
  const projects = cv.listOfAcademicExperiencesAndProjects ?? [];
  if (projects.length) L.push("\nپروژه‌ها:", ...projects.map((p: any) => `- ${t(p.title)} ${t(p.description)}`.trim()));
  const awards = cv.listOfAwardsAndHonors ?? [];
  if (awards.length) L.push("\nافتخارات:", ...awards.map((p: any) => `- ${t(p.title)}`));
  const cover = d?.coverLetter ?? d?.applicationCoverLetterSummary;
  if (cover) L.push("\nنامهٔ همراه:", typeof cover === "string" ? cover : t(cover.text ?? cover.content ?? JSON.stringify(cover)));
  return L.join("\n");
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

export class JobvisionSource implements Source {
  name: string;
  private token: string;
  private titles = new Map<number, string>();
  /** If set, overrides cfg.jobPostIds for the next listApplications() (used by the dashboard). */
  onlyJobs?: number[];

  constructor(private cfg: JobvisionSourceConfig) {
    this.name = cfg.name;
    this.token = cfg.token.replace(/^Bearer\s+/i, "").trim();
  }

  private checkToken() {
    if (!this.token) throw new AuthError(`${this.name}: JOBVISION_TOKEN is empty. Copy the Authorization header (without "Bearer ") from DevTools into .env`);
    if (/[^\x21-\x7e]/.test(this.token))
      throw new AuthError(`${this.name}: JOBVISION_TOKEN contains invalid characters (e.g. "…" or spaces) - it was copied truncated. In DevTools turn on "Raw" for the request headers and copy the full Authorization value.`);
    if (this.token.split(".").length !== 3)
      throw new AuthError(`${this.name}: JOBVISION_TOKEN does not look like a full token (expected 3 parts separated by dots). Copy the full Authorization value again.`);
    const exp = jwtExpiry(this.token);
    if (exp && exp.getTime() < Date.now() + 60_000)
      throw new AuthError(`${this.name}: token expired at ${exp.toISOString()}. Log in to employer.jobvision.ir and paste a fresh token into .env`);
  }

  private async api(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const url = `${this.cfg.apiBase}${path}`;
    const res = await httpFetch(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json, text/plain, */*",
          Origin: this.cfg.panelBase,
          Referer: `${this.cfg.panelBase}/`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.cfg.proxy,
    );
    if (res.status === 401 || res.status === 403) throw new AuthError(`${this.name}: ${res.status} on ${path} - token expired or invalid, paste a fresh one into .env`);
    const text = await res.text();
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`);
    const env = Envelope.safeParse(JSON.parse(text));
    if (!env.success) throw new Error(`${this.name}: unexpected response shape on ${path} (API changed?): ${text.slice(0, 200)}`);
    if (!env.data.isSuccess) throw new Error(`${this.name}: ${path} failed: ${env.data.message ?? "unknown error"}`);
    await sleep(this.cfg.delayMs);
    return env.data.data;
  }

  async listApplications(): Promise<Application[]> {
    this.checkToken();
    const out: Application[] = [];
    const jobIds = this.onlyJobs ?? this.cfg.jobPostIds;
    if (!jobIds.length) throw new Error(`${this.name}: no jobPostIds configured`);
    for (const jobPostId of jobIds) {
      const header = await this.api("GET", `/jobpost/GetJobHeaderData?jobPostId=${jobPostId}`);
      const jobTitle = t(header?.jobPostTitle) || `Job ${jobPostId}`;
      this.titles.set(jobPostId, jobTitle);

      const ids: number[] = (await this.api("POST", "/JobPostApplication/GetFilteredApplicationsIds", { status: this.cfg.status, sortBy: 0, jobPostId })) ?? [];
      const wanted = ids.slice(0, this.cfg.maxPerJob);
      for (let i = 0; i < wanted.length; i += 10) {
        const batch = wanted.slice(i, i + 10);
        const data = await this.api("POST", "/JobPostApplication/GetListOfApplicationsSummary", { jobPostId, listOfApplicationsId: batch });
        for (const s of data?.listOfApplicationSummaries ?? []) out.push(this.mapSummary(s, jobPostId, jobTitle));
      }
    }
    return out;
  }

  /** Active job posts (statusId 1) from the employer panel. */
  async listJobs(statusId = 1): Promise<JobPost[]> {
    this.checkToken();
    const out: JobPost[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.api("POST", "/JobPost/GetListOfJobPosts", { statusId, keyword: "", pageNumber: page, pageSize: 50 });
      const items: any[] = data?.listOfJobPostSummaries ?? [];
      for (const j of items)
        out.push({
          id: String(j.id), title: t(j.title), city: t(j.cityName) || null, status: t(j.status) || null,
          expireDate: j.expireDate ?? null, timeDescription: t(j.timeDescription) || null, submitter: t(j.fullName) || null,
        });
      if (items.length < 50) break;
    }
    return out;
  }

  /** Counters shown in the panel for one job (new, undecided, rejected, total). */
  async jobCounts(jobPostId: string): Promise<{ total: number; undecided: number; rejected: number; newCount: number }> {
    const d = await this.api("GET", `/JobPostApplication/GetApplicationManagementHeader?jobPostId=${jobPostId}`);
    return { total: d?.totalCount ?? 0, undecided: d?.unsetStatusCount ?? 0, rejected: d?.rejectedCount ?? 0, newCount: d?.newResumeCount ?? 0 };
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
      extra: {
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
    const d = await this.api("GET", `/JobPostApplication/GetApplicationDetails2?applicationId=${app.id}&cvlang=1`);
    // Fill the PDF link from details if the summary did not have it
    const f = d?.cvDetail?.cvFiles;
    if (!app.resumeUrl && f?.hasPersonalCv) app.resumeUrl = f.personalCvPdfUrl || (f.personalCvFileId ? `${this.cfg.fileBase}/Files/Download?FileId=${f.personalCvFileId}` : undefined);
    return cvToText(d);
  }

  async downloadResume(app: Application): Promise<ResumeFile | null> {
    if (!app.resumeUrl) return null;
    const res = await httpFetch(app.resumeUrl, { headers: { Authorization: `Bearer ${this.token}`, Referer: `${this.cfg.panelBase}/` } }, this.cfg.proxy);
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} downloading PDF`);
    const ct = res.headers.get("content-type") ?? "application/pdf";
    const safe = app.name.replace(/[\\/:*?"<>|]+/g, "").trim() || app.id;
    return { data: new Uint8Array(await res.arrayBuffer()), filename: `${safe} - ${app.jobTitle ?? "resume"}.pdf`, contentType: ct };
  }
}
