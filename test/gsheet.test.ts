import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeRule, normKey, ruleMatches, SheetRule } from '../core/ats/infra/gsheet';

const person = {
      decision: 'accepted',
      score: 80,
      years: 5,
      experienceAlerts: 0,
      city: 'اصفهان',
      siteStatus: null,
      hasAttachment: true,
};

test('rule: defaults = accepted + partial, not rejected on the site', () => {
      const r = SheetRule.parse({});
      assert.ok(ruleMatches(r, person));
      assert.ok(ruleMatches(r, { ...person, decision: 'partial' }));
      assert.ok(!ruleMatches(r, { ...person, decision: 'rejected' }));
      assert.ok(!ruleMatches(r, { ...person, siteStatus: 'rejected' }));
});

test('rule: score, years, clean history, city', () => {
      const r = SheetRule.parse({
            minScore: 70,
            minYears: 3,
            maxExperienceAlerts: 0,
            cities: ['اصفهان'],
      });
      assert.ok(ruleMatches(r, person));
      assert.ok(!ruleMatches(r, { ...person, score: 65 }));
      assert.ok(!ruleMatches(r, { ...person, years: 2 }));
      assert.ok(!ruleMatches(r, { ...person, experienceAlerts: 1 }));
      assert.ok(!ruleMatches(r, { ...person, city: 'تهران' }));
      assert.ok(ruleMatches(r, { ...person, city: 'نجف آباد، اصفهان' }));
      assert.deepEqual(describeRule(r), [
            'وضعیت: قبول، تایید نسبی',
            'امتیاز حداقل ۷۰',
            'سابقهٔ کار حداقل ۳ سال',
            'بدون هشدار در سوابق کاری',
            'شهر: اصفهان',
            'به‌جز کسانی که در جاب‌ویژن رد شده‌اند',
      ]);
});

test('normKey: phone numbers in any format compare equal', () => {
      const want = normKey('09131234567');
      for (const v of ['+98 913 123 4567', '۰۹۱۳۱۲۳۴۵۶۷', '9131234567', '0913-123-4567'])
            assert.equal(normKey(v), want, v);
      assert.equal(normKey('  علي  رضايي '), normKey('علی رضایی'));
});

test('ruleReason explains exclusions in Persian', async () => {
      const { ruleReason } = await import('../core/ats/infra/gsheet');
      const r = SheetRule.parse({ minScore: 60 });
      assert.equal(ruleReason(r, person), null);
      assert.equal(ruleReason(r, { ...person, siteStatus: 'rejected' }), 'در جاب‌ویژن رد شده');
      assert.equal(ruleReason(r, { ...person, score: 55 }), 'امتیاز ۵۵ کمتر از ۶۰');
      assert.equal(ruleReason(r, { ...person, decision: 'rejected' }), 'وضعیت «رد» در شرط نیست');
});

test('Google web pages instead of data are explained', async () => {
      const { explainGoogleHtml } = await import('../core/ats/infra/gsheet');
      assert.match(
            explainGoogleHtml(
                  '<html><title>Error</title><body>Script function not found: doPost</body></html>',
                  200,
            ),
            /doPost پیدا نشد/,
      );
      assert.match(
            explainGoogleHtml(
                  '<html><body><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>',
                  200,
            ),
            /Anyone/,
      );
      assert.match(
            explainGoogleHtml(
                  '<html><title>Google Drive</title><body>Sorry, unable to open the file at this time.</body></html>',
                  200,
            ),
            /آدرس Web app اشتباه/,
      );
      const unknown = explainGoogleHtml(
            '<html><title>Something</title><body>weird page</body></html>',
            200,
      );
      assert.match(unknown, /پیام گوگل \(HTTP 200\): Something — /);
});
