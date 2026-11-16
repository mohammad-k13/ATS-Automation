import assert from "node:assert/strict";
import { test } from "node:test";
import { pickCriteria } from "../src/criteria";
import { Db } from "../src/db";
import { runOnce } from "../src/pipeline";
import { hardFilterFailures, hasKeyword, keywordScore, KeywordScorer } from "../src/score";
import { HttpSource } from "../src/sources/http-source";
import type { Notifier } from "../src/telegram";
import type { Application, Criteria, Source } from "../src/types";
import { getPath, interpolate } from "../src/util";

const crit: Criteria = {
  name: "backend",
  match: { titleIncludes: ["backend", "بک اند"] },
  threshold: 70,
  partialThreshold: 50,
  mustHave: ["Node.js", "PostgreSQL"],
  niceToHave: ["Docker"],
  hardFilters: { rejectIfAny: ["intern only"], minYears: 2 },
};

test("util: getPath and interpolate", () => {
  assert.equal(getPath({ a: { b: [{ c: 5 }] } }, "a.b.0.c"), 5);
  assert.deepEqual(getPath([1], "."), [1]);
  assert.deepEqual(interpolate({ h: "Bearer ${T}" }, { T: "x" } as unknown as NodeJS.ProcessEnv), { h: "Bearer x" });
});

test("keyword matching handles case, boundaries and Persian variants", () => {
  assert.ok(hasKeyword("I use node.js daily", "Node.js"));
  assert.ok(!hasKeyword("javascript", "Java"));
  assert.ok(hasKeyword("برنامه نويس بک اند", "بک اند")); // Arabic ي vs Persian ی
  assert.equal(keywordScore("Node.js PostgreSQL", crit).score, 86);
});

test("hard filters", () => {
  assert.deepEqual(hardFilterFailures("intern only", crit, 5), ["contains rejected term: intern only"]);
  assert.deepEqual(hardFilterFailures("x", crit, 1), ["experience 1y < 2y"]);
  assert.deepEqual(hardFilterFailures("x", crit, null), []);
});

test("criteria picking by title and default fallback", () => {
  const def = { ...crit, name: "default", match: {} };
  assert.equal(pickCriteria([crit, def], { jobTitle: "Senior Backend Dev" } as Application)?.name, "backend");
  assert.equal(pickCriteria([crit, def], { jobTitle: "Designer" } as Application)?.name, "default");
  assert.equal(pickCriteria([crit], { jobTitle: "Designer" } as Application), undefined);
});

test("http source maps items", () => {
  const s = new HttpSource({
    name: "x", type: "http", enabled: true, baseUrl: "https://ex.ir", headers: {}, delayMs: 0,
    list: { url: "/a", method: "GET", itemsPath: "data", startPage: 1, maxPages: 1 },
    fields: { id: "id", name: "user.name", jobTitle: "job.title", extra: { city: "city" } },
    resumeUrlTemplate: "/r/{id}.pdf",
  });
  const a = s.mapItem({ id: 7, user: { name: "Ali" }, job: { title: "Backend" }, city: "Tehran" });
  assert.equal(a.id, "7");
  assert.equal(a.name, "Ali");
  assert.equal(a.resumeUrl, "https://ex.ir/r/7.pdf");
  assert.deepEqual(a.extra, { city: "Tehran" });
});

test("pipeline: accepts good, rejects bad, never processes twice", async () => {
  const apps: Application[] = [
    { source: "fake", id: "1", name: "Good", jobTitle: "Backend", resumeText: "Node.js PostgreSQL Docker, 5 years building services" },
    { source: "fake", id: "2", name: "Bad", jobTitle: "Backend", resumeText: "Photoshop and Illustrator designer with branding work" },
  ];
  const src: Source = { name: "fake", listApplications: async () => apps, downloadResume: async () => null };
  const sent: string[] = [];
  const notifier: Notifier = { sendAccepted: async (a) => void sent.push(a.name), sendText: async () => {} };
  const db = new Db(":memory:");
  const opts = { sources: [src], criteria: [crit], db, scorer: new KeywordScorer(), notifier, log: () => {} };

  const r1 = await runOnce(opts);
  assert.deepEqual(sent, ["Good"]);
  assert.equal(r1.rejected.length, 1);

  const r2 = await runOnce(opts);
  assert.deepEqual(sent, ["Good"]); // nothing re-sent
  assert.equal(r2.skipped, 2);
});

test("partial approval band: accept ≥ threshold, partial ≥ partialThreshold, else rejected; hard filters always reject", async () => {
  const { decisionOf } = await import("../src/types");
  const c: Criteria = { ...crit, threshold: 70, partialThreshold: 50, mustHave: ["Node.js", "PostgreSQL"], niceToHave: ["Docker", "Redis"], hardFilters: {} };
  const s = new KeywordScorer();
  // must 2x3 + nice 2x1 = 8 points
  const full = await s.score({ source: "t", id: "1", name: "a" }, "Node.js PostgreSQL Docker Redis", c); // 100
  const mid = await s.score({ source: "t", id: "2", name: "b" }, "Node.js Docker", c); // 4/8 = 50
  const low = await s.score({ source: "t", id: "3", name: "c" }, "Docker", c); // 1/8 = 13
  assert.equal(decisionOf(full), "accepted");
  assert.equal(decisionOf(mid), "partial");
  assert.equal(decisionOf(low), "rejected");
  const blocked = await s.score({ source: "t", id: "4", name: "d" }, "Node.js PostgreSQL Docker Redis intern only", { ...c, hardFilters: { rejectIfAny: ["intern only"] } });
  assert.equal(decisionOf(blocked), "rejected");
});
