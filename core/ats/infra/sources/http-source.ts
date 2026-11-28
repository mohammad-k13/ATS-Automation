import { z } from 'zod';
import { httpFetch } from '../../../shared/http';
import type { Application, ResumeFile, Source } from '../../domain/types';
import { getPath, sleep } from '../../../shared/util';

/**
 * Generic source driven by sources.yaml: point it at the employer-panel endpoint you found in
 * DevTools, tell it where the list of applicants lives in the JSON and which field is which.
 */
export const HttpSourceConfig = z.object({
    name: z.string(),
    type: z.literal('http'),
    enabled: z.boolean().default(true),
    baseUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    delayMs: z.number().default(1500),
    list: z.object({
        url: z.string(), // may contain {page}
        method: z.enum(['GET', 'POST']).default('GET'),
        body: z.any().optional(), // JSON body for POST; strings may contain {page}
        itemsPath: z.string().default('.'),
        startPage: z.number().default(1),
        maxPages: z.number().default(1),
    }),
    fields: z.object({
        id: z.string(),
        name: z.string().optional(),
        jobId: z.string().optional(),
        jobTitle: z.string().optional(),
        appliedAt: z.string().optional(),
        profileUrl: z.string().optional(),
        resumeUrl: z.string().optional(),
        resumeText: z.string().optional(),
        extra: z.record(z.string(), z.string()).default({}),
    }),
    /** Optional template if the resume URL must be built, e.g. "https://x/api/resume/{id}/download". */
    resumeUrlTemplate: z.string().optional(),
    profileUrlTemplate: z.string().optional(),
    proxy: z.string().optional(),
});
export type HttpSourceConfig = z.infer<typeof HttpSourceConfig>;

function fill(tpl: string, vars: Record<string, unknown>): string {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(vars[k] ?? '')));
}

function fillDeep(v: unknown, vars: Record<string, unknown>): unknown {
    if (typeof v === 'string') {
        const m = v.match(/^\{(\w+)\}$/);
        return m ? vars[m[1]] : v.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
    }
    if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
    return v;
}

export class HttpSource implements Source {
    name: string;
    constructor(private cfg: HttpSourceConfig) {
        this.name = cfg.name;
    }

    private abs(url: string) {
        return this.cfg.baseUrl ? new URL(url, this.cfg.baseUrl).toString() : url;
    }

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        // drop empty values (unset env vars)
        return Object.fromEntries(Object.entries({ ...this.cfg.headers, ...extra }).filter(([, v]) => v !== ''));
    }

    async fetchPage(page: number): Promise<unknown> {
        const { list } = this.cfg;
        const url = this.abs(fill(list.url, { page }));
        const init =
            list.method === 'POST'
                ? {
                      method: 'POST',
                      headers: this.headers({ 'content-type': 'application/json' }),
                      body: JSON.stringify(fillDeep(list.body ?? {}, { page })),
                  }
                : { method: 'GET', headers: this.headers() };
        const res = await httpFetch(url, init, this.cfg.proxy);
        const body = await res.text();
        if (res.status === 401 || res.status === 403)
            throw new AuthError(
                `${this.name}: ${res.status} from ${url} - session/token expired? Update the cookie/token in .env`,
            );
        if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`);
        try {
            return JSON.parse(body);
        } catch {
            throw new Error(
                `${this.name}: expected JSON from ${url}, got: ${body.slice(0, 300)} (logged out? redirected to login page?)`,
            );
        }
    }

    mapItem(item: any): Application {
        const f = this.cfg.fields;
        const str = (p?: string) => {
            const v = getPath(item, p);
            return v == null || v === '' ? undefined : String(v);
        };
        const id = str(f.id);
        if (!id) throw new Error(`${this.name}: item has no id at "${f.id}": ${JSON.stringify(item).slice(0, 200)}`);
        const vars = { ...item, id };
        const extra = Object.fromEntries(Object.entries(f.extra).map(([k, p]) => [k, getPath(item, p)]));
        let resumeUrl =
            str(f.resumeUrl) ?? (this.cfg.resumeUrlTemplate ? fill(this.cfg.resumeUrlTemplate, vars) : undefined);
        if (resumeUrl) resumeUrl = this.abs(resumeUrl);
        let profileUrl =
            str(f.profileUrl) ?? (this.cfg.profileUrlTemplate ? fill(this.cfg.profileUrlTemplate, vars) : undefined);
        if (profileUrl) profileUrl = this.abs(profileUrl);
        return {
            source: this.name,
            id,
            name: str(f.name) ?? `Applicant ${id}`,
            jobId: str(f.jobId),
            jobTitle: str(f.jobTitle),
            appliedAt: str(f.appliedAt),
            profileUrl,
            resumeUrl,
            resumeText: str(f.resumeText),
            extra,
            raw: item,
        };
    }

    async listApplications(): Promise<Application[]> {
        const { list } = this.cfg;
        const out: Application[] = [];
        for (let p = list.startPage; p < list.startPage + list.maxPages; p++) {
            const json = await this.fetchPage(p);
            const items = getPath(json, list.itemsPath);
            if (!Array.isArray(items))
                throw new Error(
                    `${this.name}: "${list.itemsPath}" is not an array in the response. Run "npm run probe -- ${this.name}" to inspect it.`,
                );
            if (items.length === 0) break;
            out.push(...items.map((i) => this.mapItem(i)));
            if (p < list.startPage + list.maxPages - 1) await sleep(this.cfg.delayMs);
        }
        return out;
    }

    async downloadResume(app: Application): Promise<ResumeFile | null> {
        if (!app.resumeUrl) return null;
        await sleep(this.cfg.delayMs);
        const res = await httpFetch(app.resumeUrl, { headers: this.headers() }, this.cfg.proxy);
        if (res.status === 401 || res.status === 403)
            throw new AuthError(`${this.name}: ${res.status} downloading resume - session expired?`);
        if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} downloading resume ${app.resumeUrl}`);
        const ct = res.headers.get('content-type') ?? undefined;
        const cd = res.headers.get('content-disposition') ?? '';
        const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
        const ext = ct?.includes('pdf') ? '.pdf' : ct?.includes('word') ? '.docx' : '';
        const filename = fromHeader ? decodeURIComponent(fromHeader) : `${app.source}_${app.id}${ext || '.pdf'}`;
        return { data: new Uint8Array(await res.arrayBuffer()), filename, contentType: ct };
    }
}

export class AuthError extends Error {}
