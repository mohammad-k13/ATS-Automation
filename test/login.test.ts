import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { loginInBrowser } from "../src/auth/jobvision-login";

// Email step, then an SMS-code form by default with a "log in with password" link.
const PAGE = `<!doctype html><html><body>
<form id="a" onsubmit="event.preventDefault();a.hidden=true;b.hidden=false">
  <input name="Username" type="text"><button type="submit">ادامه</button></form>
<div id="b" hidden><input name="Code" type="text" placeholder="کد پیامک"><a href="#" onclick="b.hidden=true;c.hidden=false">ورود با رمز عبور</a></div>
<form id="c" hidden onsubmit="event.preventDefault();sessionStorage.setItem('oidc.user:x', JSON.stringify({access_token:'aaa.bbb.ccc'}))">
  <input name="Password" type="password"><button type="submit">ورود</button></form>
</body></html>`;

const hasBrowser = ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].some((p) => fs.existsSync(p));

test("login picks «ورود با رمز عبور» when the site offers an SMS code first", { skip: !hasBrowser && "no Chromium" }, async () => {
  const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(PAGE); }).listen(8814);
  try {
    const log: string[] = [];
    const r = await loginInBrowser({ email: "a@b.c", password: "pw", loginUrl: "http://127.0.0.1:8814/", log: (l) => log.push(l) });
    assert.equal(r.token, "aaa.bbb.ccc");
    assert.ok(log.some((l) => l.includes("ورود با رمز عبور")));
  } finally {
    srv.close();
  }
});

test("login reads the token from the sign-in redirect, and describes an unknown page", { skip: !hasBrowser && "no Chromium" }, async () => {
  const FORM = `<!doctype html><html><body><form action="/cb" onsubmit="event.preventDefault();location.href='/cb#access_token=ddd.eee.fff&token_type=Bearer'">
    <input name="Email" type="email"><input name="Password" type="password"><button type="submit">ورود</button></form></body></html>`;
  const SMS = `<!doctype html><html><body><input name="Mobile" type="tel" placeholder="شماره موبایل"><button>دریافت کد</button></body></html>`;
  const srv = http.createServer((q, r) => {
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(q.url?.startsWith("/sms") ? SMS : q.url?.startsWith("/cb") ? "<html><body>ok</body></html>" : FORM);
  }).listen(8815);
  try {
    const r = await loginInBrowser({ email: "a@b.c", password: "pw", loginUrl: "http://127.0.0.1:8815/" });
    assert.equal(r.token, "ddd.eee.fff");
    await assert.rejects(loginInBrowser({ email: "a@b.c", password: "pw", loginUrl: "http://127.0.0.1:8815/sms", timeoutMs: 5000 }), (e: Error) => {
      assert.match(e.message, /فیلدها: tel name=Mobile «شماره موبایل»/);
      assert.match(e.message, /دکمه‌ها: دریافت کد/);
      return true;
    });
  } finally {
    srv.close();
  }
});
