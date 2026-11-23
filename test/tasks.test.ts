import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCsv, describePlan, sanitizePlan } from '../core/platform/tasks';

test('plan: defaults, unknown fields dropped, files get default columns', () => {
      const p = sanitizePlan({
            title: 'قبولی‌ها',
            destination: { type: 'csv' },
            columns: [
                  { field: 'name', label: 'نام' },
                  { field: 'nonsense', label: 'x' },
            ],
      });
      assert.deepEqual(p.columns, [{ field: 'name', label: 'نام' }]);
      assert.deepEqual(p.filter.decisions, ['accepted', 'partial']);
      assert.equal(p.jobs, 'all');
      const d = sanitizePlan({ destination: { type: 'xlsx' } });
      assert.ok(
            d.columns.some((c) => c.field === 'phone'),
            'a file without columns gets sensible ones',
      );
      const g = sanitizePlan({
            title: 'مصاحبه',
            destination: { type: 'gsheet' },
            columns: [{ field: 'name', label: 'نام' }],
      });
      assert.equal(
            g.destination.sheet,
            'مصاحبه',
            'a sheet task without a tab name writes to a tab named after it',
      );
});

test('plan description is plain Persian', () => {
      const p = sanitizePlan({
            title: 'نگهبان',
            jobs: ['7'],
            filter: { decisions: ['accepted'], minScore: 70, lastDays: 7 },
            destination: { type: 'gsheet', sheet: 'مصاحبه' },
            mapping: { نام: 'name', تلفن: 'phone', توضیح: null },
            keyColumn: 'تلفن',
      });
      const d = describePlan(p, { '7': 'نگهبان' }, [
            { name: 'مصاحبه', headers: ['نام', 'تلفن', 'توضیح'], rows: 3 },
      ]);
      assert.deepEqual(d, [
            'آگهی‌ها: «نگهبان»',
            'چه کسانی: وضعیت قبول، امتیاز حداقل ۷۰، ارسال‌شده در ۷ روز اخیر، به‌جز ردشده‌ها در جاب‌ویژن',
            'مقصد: گوگل شیت، برگهٔ «مصاحبه»',
            'تکراری‌ها با ستون «تلفن» شناخته و اضافه نمی‌شوند',
            'ستون‌ها: نام ← نام کارجو، تلفن ← تلفن، توضیح ← خالی',
            'ترتیب: امتیاز (بیشترین اول)',
      ]);
      assert.match(
            describePlan({ ...p, destination: { type: 'gsheet', sheet: 'جدید' } }, {}, [])[2],
            /برگهٔ جدید ساخته می‌شود/,
      );
});

test('CSV opens in Excel with Persian and keeps commas/quotes/zeros', () => {
      const bytes = buildCsv(['نام', 'تلفن', 'توضیح'], [['علی', '09120000001', 'گفت "سلام", خوب']]);
      assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM so Excel reads UTF-8');
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      assert.equal(text, '﻿نام,تلفن,توضیح\r\nعلی,09120000001,"گفت ""سلام"", خوب"\r\n');
});
