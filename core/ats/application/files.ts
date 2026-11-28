/** Resume files (Jobvision PDF + attached file), ZIP downloads, and the attachment-download diagnosis tool. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { diagnoseAttachment } from '../infra/auth/jobvision-diagnose';
import { credentials, saveCookies, tokenKey } from '../infra/auth/token';
import { jalaliDate } from '../infra/exports';
import { AuthError } from '../infra/sources/http-source';
import { fileAuthMemo } from '../infra/sources/jobvision-source';
import { buildXlsx } from '../infra/xlsx';
import type { Row } from '../infra/db';
import { dataDir, db, jobvision, needToken, parse, rowApp, safeName, UserError } from './state';

/** Both files of one candidate (Jobvision PDF + attached file), cached on disk after the first download. */
async function candidateFiles(
    src: string,
    r: Row,
): Promise<{ files: { name: string; data: Uint8Array }[]; errors: string[] }> {
    const s = jobvision(src);
    const dir = path.join(dataDir(), 'files', src, r.id);
    await fsp.mkdir(dir, { recursive: true });
    const cached = await fsp.readdir(dir).catch(() => [] as string[]);
    const files: { name: string; data: Uint8Array }[] = [];
    const errors: string[] = [];
    const app = rowApp(src, r);

    const jv = cached.find((f) => f.startsWith('رزومه جاب‌ویژن'));
    if (jv) files.push({ name: jv, data: await fsp.readFile(path.join(dir, jv)) });
    else
        try {
            const f = await s.downloadJobvisionCv(app);
            await fsp.writeFile(path.join(dir, f.filename), f.data);
            files.push({ name: f.filename, data: f.data });
        } catch (e) {
            if (e instanceof AuthError) throw e;
            errors.push(`رزومهٔ جاب‌ویژن: ${e instanceof Error ? e.message : e}`);
        }

    const att = cached.find((f) => f.startsWith('رزومه پیوست'));
    if (att) files.push({ name: att, data: await fsp.readFile(path.join(dir, att)) });
    else if (app.extra?.personalCvFileId || app.resumeUrl)
        try {
            const f = await s.downloadAttachedCv(app);
            if (f) {
                await fsp.writeFile(path.join(dir, f.filename), f.data);
                files.push({ name: f.filename, data: f.data });
            }
        } catch (e) {
            if (e instanceof AuthError) throw e;
            errors.push(`فایل پیوست: ${e instanceof Error ? e.message : e}`);
        }
    return { files, errors };
}

export interface ZipTask {
    running: boolean;
    done: number;
    total: number;
    current: string | null;
    token?: string;
    filename?: string;
    errors: string[];
    error?: string;
    startedAt: string;
}
const zipTasks = () => ((globalThis as any).__atsZipTasks ??= new Map<string, ZipTask>()) as Map<string, ZipTask>;
export const getZipTask = (src: string, jobId: string) => zipTasks().get(`${src}:${jobId}`) ?? null;

/** Build a ZIP of resumes in the background: selected ids, or everyone with the given decisions. */
export async function startZip(src: string, jobId: string, opts: { ids?: string[]; decisions?: string[] }) {
    const key = `${src}:${jobId}`;
    if (zipTasks().get(key)?.running) throw new UserError('ساخت فایل فشرده برای این آگهی در حال اجراست', 409);
    await needToken(src);
    const decisions = opts.decisions ?? ['accepted', 'partial'];
    const rows = db()
        .listByJob(src, jobId)
        .filter((r) => (opts.ids?.length ? opts.ids.includes(r.id) : decisions.includes(r.decision)));
    if (!rows.length)
        throw new UserError(opts.ids?.length ? 'رزومه‌ای انتخاب نشده' : 'رزومهٔ قبول یا تایید نسبی وجود ندارد');
    const title = rows[0].job ?? `آگهی ${jobId}`;
    const task: ZipTask = {
        running: true,
        done: 0,
        total: rows.length,
        current: null,
        errors: [],
        startedAt: new Date().toISOString(),
    };
    zipTasks().set(key, task);

    (async () => {
        const zip: Record<string, Uint8Array> = {};
        const STATUS: Record<string, string> = {
            accepted: 'قبول',
            partial: 'تایید نسبی',
            rejected: 'رد',
            pending: 'بررسی‌نشده',
            error: 'خطا',
        };
        const index: (string | number)[][] = [];
        for (const [i, r] of rows.entries()) {
            task.current = r.name;
            const folder = safeName(
                `${String(i + 1).padStart(2, '0')} - ${r.name}${r.score != null ? ` - ${r.score}` : ''}`,
            );
            try {
                const { files, errors } = await candidateFiles(src, r);
                for (const f of files) zip[`${folder}/${f.name}`] = f.data;
                for (const e of errors) task.errors.push(`${r.name}: ${e}`);
            } catch (e) {
                if (e instanceof AuthError) {
                    task.error = 'توکن منقضی شده؛ دوباره وارد شوید.';
                    break;
                }
                task.errors.push(`${r.name}: ${e instanceof Error ? e.message : e}`);
            }
            index.push([
                i + 1,
                r.name,
                r.phone ?? '',
                STATUS[r.decision] ?? r.decision,
                r.score ?? '',
                jalaliDate(r.applied_at),
                folder,
            ]);
            task.done++;
        }
        zip['فهرست.xlsx'] = buildXlsx(
            'فهرست',
            ['ردیف', 'نام کارجو', 'تلفن', 'وضعیت', 'امتیاز', 'تاریخ دریافت', 'پوشه'],
            index,
        );
        const token = randomUUID();
        const dir = path.join(dataDir(), 'exports');
        await fsp.mkdir(dir, { recursive: true });
        // keep only recent exports
        for (const f of await fsp.readdir(dir)) {
            const st = await fsp.stat(path.join(dir, f)).catch(() => null);
            if (st && Date.now() - st.mtimeMs > 86_400_000) await fsp.rm(path.join(dir, f), { force: true });
        }
        await fsp.writeFile(path.join(dir, `${token}.zip`), zipSync(zip, { level: 0 }));
        task.token = token;
        task.filename = `${safeName(title)} - ${opts.ids?.length ? 'انتخاب‌شده‌ها' : 'قبول و نسبی'} - ${jalaliDate(new Date().toISOString()).replace(/\//g, '-')}.zip`;
    })()
        .catch((e) => (task.error = e instanceof Error ? e.message : String(e)))
        .finally(() => {
            task.running = false;
            task.current = null;
        });
    return task;
}

export async function zipFile(token: string): Promise<Uint8Array> {
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new UserError('not found', 404);
    return fsp.readFile(path.join(dataDir(), 'exports', `${token}.zip`)).catch(() => {
        throw new UserError('فایل پیدا نشد یا منقضی شده', 404);
    });
}

/** Files of one candidate for the resume panel. */
export async function candidateFile(src: string, id: string, kind: 'jobvision' | 'attached') {
    const r = db().get(src, id);
    if (!r) throw new UserError('رزومه پیدا نشد', 404);
    await needToken(src);
    const { files, errors } = await candidateFiles(src, r);
    const f = files.find((x) => x.name.startsWith(kind === 'jobvision' ? 'رزومه جاب‌ویژن' : 'رزومه پیوست'));
    if (!f)
        throw new UserError(
            errors.find((e) => e.startsWith(kind === 'jobvision' ? 'رزومهٔ جاب‌ویژن' : 'فایل پیوست')) ??
                'این کارجو فایل پیوست ندارد',
            404,
        );
    return { name: `${safeName(r.name)} - ${f.name}`, data: f.data };
}

/**
 * Fix for "attached resume gives 401": open the panel in a hidden browser on this server, click the
 * download icon like a person would, record what the browser sends (names only), keep the login
 * cookies, and retry our own download with them. Returns a report that is safe to share.
 */
export async function diagnoseAttachmentDownload(src: string) {
    await needToken(src);
    const s = jobvision(src);
    const row = db()
        .list(5000)
        .find((r) => r.source === src && parse(r.extra_json)?.personalCvFileId);
    if (!row) throw new UserError('هیچ کارجویی با فایل پیوست در پایگاه داده نیست؛ اول رزومه‌ها را دریافت کنید.');
    const app = rowApp(src, row);
    const links = s.attachmentLinks(app);
    const log: string[] = [];
    const { email, password } = credentials(src);
    let d;
    try {
        d = await diagnoseAttachment({
            email,
            password,
            token: process.env[tokenKey(src)] ?? '',
            panelBase: links.panelBase,
            profileUrl: links.profileUrl,
            fileUrl: links.fileUrl!,
            log: (l) => log.push(l),
        });
    } catch (e) {
        throw new UserError(`اجرای مرورگر ناموفق بود: ${e instanceof Error ? e.message : e}\n${log.join('\n')}`, 502);
    }
    saveCookies(src, d.cookies);
    fileAuthMemo.way = undefined;
    let retry: string;
    let fixed = false;
    try {
        const f = await jobvision(src).downloadAttachedCv(app);
        fixed = !!f;
        retry = f ? `موفق ✔ (${f.data.length.toLocaleString('en')} بایت، روش: ${fileAuthMemo.way})` : 'فایلی برنگشت';
    } catch (e) {
        retry = `ناموفق: ${e instanceof Error ? e.message : e}`;
    }
    const report = [
        `ATS attachment diagnosis — ${new Date().toISOString()}`,
        `candidate: ${row.id}  job: ${row.job_id}`,
        `login: ${d.loggedInWith}  profile opened: ${d.profileOpened}  icon clicked: ${d.clicked}`,
        `direct tab open: status=${d.direct.status} type=${d.direct.contentType}`,
        `cookies saved: ${d.cookieNames.join(', ') || 'none'}`,
        `retry with our downloader: ${retry}`,
        `file-related requests (${d.requests.length}):`,
        ...d.requests
            .slice(0, 30)
            .map(
                (r) =>
                    `  ${r.method} ${r.url}\n    status=${r.status} type=${r.contentType} bytes=${r.bytes}\n    headers: ${r.headers.join(', ')}\n    cookies: ${r.cookies.join(', ') || '-'}`,
            ),
        'log:',
        ...log.map((l) => `  ${l}`),
    ].join('\n');
    return { fixed, report };
}

/** The screenshot the last failed auto-login saved (to see what the login page showed). */
export function loginScreenshot(): Uint8Array {
    const f = path.join(dataDir(), 'login-error.png');
    if (!fs.existsSync(f)) throw new UserError('تصویری ذخیره نشده', 404);
    return fs.readFileSync(f);
}
