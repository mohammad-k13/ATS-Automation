import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Db } from '../core/ats/infra/db';
import { extractExports } from '../core/ats/infra/exports';
import { buildXlsx } from '../core/ats/infra/xlsx';

function sampleRows() {
  const db = new Db(':memory:');
  const add = (id: string, name: string, decision: string, score: number, phone: string) =>
    db.save({
      source: 'jobvision',
      id,
      name,
      job: 'نگهبان',
      jobId: '9',
      decision: decision as any,
      score,
      phone,
      appliedAt: '2026-11-14T10:00:00',
      extra: { totalWorkExperienceYears: 4, city: 'اصفهان', experienceAlerts: ['فاصلهٔ ۸ ماه'] },
      result: { summary: 'خلاصه', matched: ['قوت'], missing: ['ضعف'], redFlags: [] },
    });
  add('1', 'علی', 'accepted', 88, '09120000001');
  add('2', 'رضا', 'partial', 60, '09120000002');
  add('3', 'سارا', 'rejected', 30, '09120000003');
  return db.listByJob('jobvision', '9');
}

test('AI spec -> real table: ids, status filter, columns, extra, phone filled by the server', () => {
  const rows = sampleRows();
  const answer = `این هم فایل:\n\`\`\`excel\n${JSON.stringify({ title: 'قبول و نسبی', status: ['accepted', 'partial'], columns: ['name', 'phone', 'score', 'receivedAt', 'alerts'], sort: 'score', extra: [{ label: 'نظر', values: { '2': 'مصاحبه تلفنی' } }] })}\n\`\`\`\nتمام.`;
  const { text, exports, errors } = extractExports(answer, rows, 'واحد حراست');
  assert.deepEqual(errors, []);
  assert.equal(text, 'این هم فایل:\n\nتمام.');
  const t = exports[0];
  assert.deepEqual(t.columns, [
    'ردیف',
    'نام کارجو',
    'تلفن',
    'امتیاز',
    'تاریخ دریافت رزومه',
    'هشدارها',
    'نظر',
  ]);
  assert.deepEqual(
    t.rows.map((r) => r[1]),
    ['علی', 'رضا'],
  );
  assert.equal(t.rows[0][2], '09120000001');
  assert.match(String(t.rows[0][4]), /^1405\/08\/2\d$/);
  assert.equal(t.rows[1][6], 'مصاحبه تلفنی');
});

test('bad spec gives an error, not a crash', () => {
  const { exports, errors } = extractExports('```excel\n{not json}\n```', sampleRows(), '');
  assert.equal(exports.length, 0);
  assert.equal(errors.length, 1);
});

test('xlsx file is valid (opened with python openpyxl when available)', () => {
  const data = buildXlsx(
    'گزارش: تست',
    ['ردیف', 'نام', 'امتیاز'],
    [
      [1, 'علی & <رضا>', 88],
      [2, 'سارا', ''],
    ],
  );
  assert.ok(data.length > 500);
  const file = path.join(os.tmpdir(), `ats-test-${process.pid}.xlsx`);
  fs.writeFileSync(file, data);

  const py = spawnSync(
    'python3',
    [
      '-c',
      `import openpyxl,sys; ws=openpyxl.load_workbook(sys.argv[1]).active; print(ws.title, ws.sheet_view.rightToLeft, [[c.value for c in r] for r in ws.iter_rows()])`,
      file,
    ],
    // Python on Windows prints with cp1252 by default and cannot print Persian
    { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } },
  );
  fs.unlinkSync(file);
  if (py.status !== 0 && /No module named/.test(py.stderr)) return; // openpyxl not installed
  assert.equal(py.status, 0, py.stderr);
  assert.match(py.stdout, /گزارش  تست True/);
  assert.match(py.stdout, /'علی & <رضا>', 88/);
});
