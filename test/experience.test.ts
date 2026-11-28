import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeExperience, type WorkItem } from '../core/ats/domain/experience';

const now = { year: 1405, month: 8 };
const job = (
    title: string,
    category: string,
    sy: number,
    sm: number,
    ey: number | null,
    em: number | null,
    current = false,
): WorkItem => ({
    title,
    company: 'شرکت',
    category,
    startYear: sy,
    startMonth: sm,
    endYear: ey,
    endMonth: em,
    current,
});

test('continuous career in one field: no alerts', () => {
    const a = analyzeExperience(
        [job('کارشناس تولید', 'تولید', 1395, 1, 1399, 12), job('مدیر تولید', 'تولید', 1400, 1, null, null, true)],
        { now },
    );
    assert.deepEqual(a, []);
});

test('gap between jobs, field switch, short tenures, overlap, not working now', () => {
    const a = analyzeExperience(
        [
            job('حسابدار', 'مالی', 1390, 1, 1392, 6),
            job('کارشناس فروش', 'فروش', 1394, 1, 1394, 8), // 18-month gap + switch + short
            job('کارشناس فروش', 'فروش', 1394, 9, 1395, 3), // short
            job('مدیر فروش', 'فروش', 1395, 1, 1402, 1), // overlaps the previous by 2 months (< 3, no alert)
            job('مشاور', 'فروش', 1398, 1, 1400, 1), // overlaps 24 months
        ],
        { now },
    );
    const text = a.join('\n');
    assert.match(text, /فاصلهٔ ۱ سال و ۶ ماه/);
    assert.match(text, /تغییر حوزهٔ کاری از «مالی» به «فروش»/);
    assert.match(text, /۲ سابقهٔ کوتاه‌تر از ۱ سال/);
    assert.match(text, /دو سابقهٔ همزمان به مدت ۲ سال/);
    assert.match(text, /سابقهٔ کاری ثبت نشده است/); // last job ended 1402, now 1405
    assert.ok(!/همزمان به مدت ۲ ماه/.test(text), 'short overlap ignored');
});

test('Gregorian years are converted', () => {
    const a = analyzeExperience([job('dev', 'IT', 2015, 1, 2017, 1), job('dev', 'IT', 2019, 1, null, null, true)], {
        now,
    });
    assert.match(a.join(), /فاصلهٔ ۱ سال و ۱۱ ماه/);
});
