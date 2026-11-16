import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { Db } from "../src/db";
import { runOnce } from "../src/pipeline";
import { KeywordScorer } from "../src/score";
import { cvToText, JobvisionSource, jwtExpiry } from "../src/sources/jobvision-source";
import type { Notifier } from "../src/telegram";

// Anonymized fixtures with the same shape as real employerapi.jobvision.ir responses.
const ok = (data: unknown) => JSON.stringify({ isSuccess: true, statusCode: 0, message: "ok", data });
const summary = (id: number, name: string) => ({
  applicationId: id, applicationTime: "2026-11-11T21:26:56", matchingScore: 80,
  cvSummary: { totalWorkExperience: 6, lastWorkExperienceTitle: { titleFa: "مدیر تولید" },
    basicInfo: { fullName: { titleFa: name }, residenceCity: { titleFa: "اصفهان" }, requestedSalaryRange: { titleFa: "60 - 80" } },
    cvFiles: { hasPersonalCv: true, personalCvPdfUrl: `http://127.0.0.1:${PORT}/file/${id}` } },
});
const details = (skills: string[]) => ({
  applicationId: 1, coverLetter: null,
  cvDetail: {
    aboutMe: "سابقه مدیریت تولید", totalWorkExperience: 6,
    basicInfo: { fullName: "x", gender: { title: "مرد" }, age: 44, maritalStatus: { title: "متاهل" }, militaryServiceStatus: { title: "انجام شده" }, residenceCity: { title: "اصفهان" } },
    contactData: { email: "secret@example.com", mobileNumber: "0912" },
    cvFiles: { hasPersonalCv: true },
    listOfWorkExperiences: [{ roleTitle: "مدیر تولید", companyTitle: "گروه صنعتی", dateRange: "1395 تا کنون", duration: "6 سال", seniorityLevel: { title: "مدیر میانی" } }],
    listOfEducations: [{ educationLevel: { title: "کارشناسی" }, educationField: { title: "مهندسی صنایع" }, universityName: "دانشگاه اصفهان", startYear: 1388, finishYear: 1392 }],
    listOfSoftwareSkills: skills.map((s) => ({ software: { title: s }, skillLevel: { title: "خوب" } })),
    listOfLanguageSkills: [{ language: { title: "انگلیسی" }, skillLevel: { title: "متوسط" } }],
  },
});
const PORT = 8811;
const calls: string[] = [];

function server() {
  return http.createServer((q, r) => {
    calls.push(`${q.method} ${q.url}`);
    if (q.headers.authorization !== "Bearer aaa.bbb.ccc") { r.writeHead(401); return r.end(); }
    r.setHeader("content-type", "application/json");
    const u = q.url ?? "";
    if (u.startsWith("/api/jobpost/GetJobHeaderData")) return r.end(ok({ jobPostTitle: "مدیر تولید" }));
    if (u.startsWith("/api/JobPostApplication/GetFilteredApplicationsIds")) return r.end(ok([101, 102]));
    if (u.startsWith("/api/JobPostApplication/GetListOfApplicationsSummary")) return r.end(ok({ listOfApplicationSummaries: [summary(101, "کاندید خوب"), summary(102, "کاندید ضعیف")] }));
    if (u.includes("applicationId=101")) return r.end(ok(details(["MSP", "Excel", "ERP"])));
    if (u.includes("applicationId=102")) return r.end(ok(details([])));
    if (u.startsWith("/file/")) { r.setHeader("content-type", "application/pdf"); return r.end("%PDF-1.4 fake"); }
    r.writeHead(404); r.end();
  });
}

const cfg = (token: string) => ({
  name: "jobvision", type: "jobvision" as const, enabled: true, token, jobPostIds: [1], status: 10, maxPerJob: 200, delayMs: 0,
  apiBase: `http://127.0.0.1:${PORT}/api`, fileBase: `http://127.0.0.1:${PORT}`, panelBase: "https://employer.jobvision.ir", publicJobUrl: `http://127.0.0.1:${PORT}/jobs/{id}`,
});

test("cvToText excludes gender, age, marital status and contact info", () => {
  const text = cvToText(details(["MSP"]));
  assert.match(text, /مدیر تولید در گروه صنعتی/);
  assert.match(text, /MSP/);
  assert.match(text, /وضعیت خدمت: انجام شده/);
  for (const banned of ["مرد", "44", "متاهل", "secret@example.com", "0912"]) assert.ok(!text.includes(banned), `leaked: ${banned}`);
});

test("jwtExpiry decodes exp", () => {
  const tok = `x.${Buffer.from(JSON.stringify({ exp: 1800000000 })).toString("base64url")}.y`;
  assert.equal(jwtExpiry(tok)?.toISOString(), new Date(1800000000 * 1000).toISOString());
});

test("jobvision end to end against mock API: read-only, accepts, attaches PDF, dedupes", async () => {
  const srv = server();
  await new Promise<void>((r) => srv.listen(PORT, r));
  try {
    const src = new JobvisionSource(cfg("Bearer aaa.bbb.ccc"));
    const sent: { name: string; file?: string }[] = [];
    const notifier: Notifier = { sendAccepted: async (a, _r, f) => void sent.push({ name: a.name, file: f?.filename }), sendText: async () => {} };
    const crit = { name: "prod", match: { jobIds: ["1"] }, threshold: 60, partialThreshold: 40, mustHave: ["MSP", "ERP"], niceToHave: ["Excel"], hardFilters: {} };
    const db = new Db(":memory:");
    const opts = { sources: [src], criteria: [crit], db, scorer: new KeywordScorer(), notifier, log: () => {} };

    const r = await runOnce(opts);
    assert.equal(r.accepted.length, 1);
    assert.equal(r.rejected.length, 1);
    assert.deepEqual(sent, [{ name: "کاندید خوب", file: "کاندید خوب - مدیر تولید.pdf" }]);
    assert.ok(!calls.some((c) => /ViewCv|SetLastCheck|ChangeStatus/i.test(c)), "must not call tracking/mutating endpoints");

    await runOnce(opts);
    assert.equal(sent.length, 1, "nothing re-sent");

    const bad = await runOnce({ ...opts, sources: [new JobvisionSource(cfg("xxx.yyy.zzz"))], db: new Db(":memory:") });
    assert.match(bad.errors[0].error, /401/);
  } finally {
    srv.close();
  }
});

test("extractJobAd reads JobPosting JSON-LD and falls back to meta description", async () => {
  const { extractJobAd } = await import("../src/sources/jobvision-source");
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", title: "مدیر تولید", hiringOrganization: { name: "شرکت نمونه" },
    description: "<p>شرح وظایف:</p><ul><li>برنامه‌ریزی تولید</li><li>کنترل کیفیت</li></ul>",
  })}</script></head></html>`;
  const t = extractJobAd(html);
  assert.match(t, /عنوان: مدیر تولید/);
  assert.match(t, /• برنامه‌ریزی تولید/);
  assert.ok(!t.includes("<li>"));
  const meta = `<meta name="description" content="${"آگهی استخدام مدیر تولید با سابقه در صنعت ".repeat(5)}">`;
  assert.match(extractJobAd(meta), /آگهی استخدام مدیر تولید/);
  assert.throws(() => extractJobAd("<html></html>"));
});
