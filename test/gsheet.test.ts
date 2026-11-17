import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRule, normKey, ruleMatches, SheetRule } from "../src/gsheet";

const person = { decision: "accepted", score: 80, years: 5, experienceAlerts: 0, city: "اصفهان", siteStatus: null, hasAttachment: true };

test("rule: defaults = accepted + partial, not rejected on the site", () => {
  const r = SheetRule.parse({});
  assert.ok(ruleMatches(r, person));
  assert.ok(ruleMatches(r, { ...person, decision: "partial" }));
  assert.ok(!ruleMatches(r, { ...person, decision: "rejected" }));
  assert.ok(!ruleMatches(r, { ...person, siteStatus: "rejected" }));
});

test("rule: score, years, clean history, city", () => {
  const r = SheetRule.parse({ minScore: 70, minYears: 3, maxExperienceAlerts: 0, cities: ["اصفهان"] });
  assert.ok(ruleMatches(r, person));
  assert.ok(!ruleMatches(r, { ...person, score: 65 }));
  assert.ok(!ruleMatches(r, { ...person, years: 2 }));
  assert.ok(!ruleMatches(r, { ...person, experienceAlerts: 1 }));
  assert.ok(!ruleMatches(r, { ...person, city: "تهران" }));
  assert.ok(ruleMatches(r, { ...person, city: "نجف آباد، اصفهان" }));
  assert.deepEqual(describeRule(r), ["وضعیت: قبول، تایید نسبی", "امتیاز حداقل ۷۰", "سابقهٔ کار حداقل ۳ سال", "بدون هشدار در سوابق کاری", "شهر: اصفهان", "به‌جز کسانی که در جاب‌ویژن رد شده‌اند"]);
});

test("normKey: phone numbers in any format compare equal", () => {
  const want = normKey("09131234567");
  for (const v of ["+98 913 123 4567", "۰۹۱۳۱۲۳۴۵۶۷", "9131234567", "0913-123-4567"]) assert.equal(normKey(v), want, v);
  assert.equal(normKey("  علي  رضايي "), normKey("علی رضایی"));
});
