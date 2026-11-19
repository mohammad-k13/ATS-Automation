import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'node:test';
import { renewWithCookies, type SavedCookie } from '../core/ats/infra/auth/jobvision-login';
import * as remote from '../core/ats/infra/auth/remote-login';

// A fake sign-in server with a captcha. After a manual login it remembers the browser by a cookie,
// and /authorize?prompt=none hands out a new token to that cookie (like IdentityServer).
const PORT = 8817;
const BASE = `http://127.0.0.1:${PORT}`;
const LOGIN = `<!doctype html><html><body style="margin:0">
  <form method="post" action="/login">
    <input name="captcha" style="position:absolute;left:0;top:0;width:300px;height:40px">
    <button style="position:absolute;left:0;top:60px;width:300px;height:40px">ادامه</button>
  </form></body></html>`;

function server() {
  let n = 0;
  return http.createServer((q, r) => {
    const u = q.url ?? '';
    if (u === '/login' && q.method === 'POST') {
      let body = '';
      q.on('data', (c) => (body += c));
      q.on('end', () => {
        if (!body.includes('captcha=4821')) {
          r.writeHead(200, { 'content-type': 'text/html' });
          return r.end(LOGIN);
        }
        r.writeHead(302, {
          'set-cookie': 'idsrv=session1; Path=/; HttpOnly',
          location: `/cb#access_token=aaa.bbb.c${++n}`,
        });
        r.end();
      });
      return;
    }
    if (u.startsWith('/authorize')) {
      if (/idsrv=session1/.test(q.headers.cookie ?? '')) {
        r.writeHead(302, { location: `/cb#access_token=new.tok.n${++n}` });
        return r.end();
      }
      r.writeHead(302, { location: '/cb#error=login_required' });
      return r.end();
    }
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    r.end(u.startsWith('/cb') ? '<html><body>ok</body></html>' : LOGIN);
  });
}

const hasBrowser = [
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].some((p) => fs.existsSync(p));

test(
  'manual login through the remote view, then the token renews from the cookie without a captcha',
  { skip: !hasBrowser && 'no Chromium' },
  async () => {
    const srv = server().listen(PORT);
    try {
      let saved = null as { token: string; cookies: SavedCookie[] } | null;
      await remote.startRemoteLogin({
        src: 'jobvision',
        loginUrl: `${BASE}/`,
        onDone: (token, cookies) => (saved = { token, cookies }),
      });
      assert.equal(remote.status('jobvision').open, true);
      assert.ok((await remote.screenshot('jobvision')).length > 1000);

      await remote.click('jobvision', 100 / remote.VIEW.width, 20 / remote.VIEW.height); // the captcha box
      await remote.type('jobvision', '4821');
      await remote.press('jobvision', 'Enter');
      for (let i = 0; i < 40 && !saved; i++) await new Promise((r) => setTimeout(r, 250));
      assert.ok(saved, 'token captured');
      assert.equal(saved!.token, 'aaa.bbb.c1');
      assert.ok(saved!.cookies.some((c) => c.name === 'idsrv'));

      const renewed = await renewWithCookies({
        cookies: saved!.cookies,
        authorize: `${BASE}/authorize?prompt=none`,
      });
      assert.equal(renewed?.token, 'new.tok.n2');
      assert.equal(
        await renewWithCookies({
          cookies: [{ name: 'x', value: 'y', domain: '127.0.0.1', path: '/' }],
          authorize: `${BASE}/authorize?prompt=none`,
        }),
        null,
      );
    } finally {
      await remote.cancel('jobvision');
      srv.close();
    }
  },
);
