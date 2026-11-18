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
