import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { diagnoseAttachment } from '../core/ats/infra/auth/jobvision-diagnose';
import { fileAuthMemo, JobvisionSource } from '../core/ats/infra/sources/jobvision-source';

// A fake panel + file server where the attached file only downloads with a session cookie
// that the panel sets while you browse (the bearer token alone gets 401, like the real site).
const PORT = 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(500, 32)]);

function server() {
  return http.createServer((q, r) => {
    const u = q.url ?? '';
    if (u.startsWith('/jobs/1/applications/2/jobvision-profile')) {
      r.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'fsess=abc; Path=/; HttpOnly',
      });
      return r.end(
        `<html><body><a href="/api/v1.0/Files/Download?FileId=9" target="_blank"><img src="/download-primary.svg" width="20" height="20"></a></body></html>`,
      );
    }
    if (u.endsWith('.svg')) {
      r.writeHead(200, { 'content-type': 'image/svg+xml' });
      return r.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>`,
      );
    }
    if (u.startsWith('/api/v1.0/Files/Download')) {
      if (!/fsess=abc/.test(q.headers.cookie ?? '')) {
        r.writeHead(401);
        return r.end();
      }
      r.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
      return r.end(PDF);
    }
    r.writeHead(404);
    r.end();
  });
}

const hasBrowser = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].some((p) => fs.existsSync(p));

test(
  'diagnosis learns the cookie the file server needs, then our downloader works',
  { skip: !hasBrowser && 'no Chromium' },
  async () => {
    const srv = server().listen(PORT);
    try {
      const src = new JobvisionSource({
        name: 'jobvision',
        type: 'jobvision',
        enabled: true,
        token: 'aaa.bbb.ccc',
        jobPostIds: [1],
        status: 10,
        maxPerJob: 200,
        delayMs: 0,
        apiBase: `${BASE}/api`,
        fileBase: `${BASE}/api/v1.0`,
        panelBase: BASE,
        publicJobUrl: `${BASE}/jobs/{id}`,
      } as any);
      const app = {
        source: 'jobvision',
        id: '2',
        jobId: '1',
        name: 'x',
        extra: { personalCvFileId: 9 },
      };
      delete process.env.JOBVISION_COOKIES;
      fileAuthMemo.way = undefined;
      await assert.rejects(src.downloadAttachedCv(app), /401/);

      const links = src.attachmentLinks(app);
      const d = await diagnoseAttachment({
        token: 'aaa.bbb.ccc',
        panelBase: BASE,
        profileUrl: links.profileUrl,
        fileUrl: links.fileUrl!,
      });
      assert.equal(d.loggedInWith, 'token');
      assert.ok(d.profileOpened && d.clicked);
      const file = d.requests.find((r) => r.url.includes('Files/Download'));
      assert.ok(file, 'the click reached the file server');
      assert.deepEqual(file!.cookies, ['fsess']); // names only
      assert.equal(file!.status, 200);
      assert.equal(d.direct.status, 200);
      assert.ok(!JSON.stringify(d.requests).includes('abc'), 'no cookie values in the report');

      process.env.JOBVISION_COOKIES = JSON.stringify(d.cookies);
      const f = await src.downloadAttachedCv(app);
      assert.equal(f?.data.length, PDF.length);
      assert.equal(fileAuthMemo.way, 'cookie+bearer');
    } finally {
      srv.close();
      delete process.env.JOBVISION_COOKIES;
    }
  },
);
