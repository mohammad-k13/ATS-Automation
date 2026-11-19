/**
 * Log in to the Jobvision employer panel with email + password using the browser already on this
 * machine (Edge or Chrome) and capture the API token the panel uses.
 * Nothing is downloaded: playwright-core drives the installed browser.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface LoginOptions {
  email: string;
  password: string;
  /** Show the browser window (needed if the site asks for a captcha / code). */
  show?: boolean;
  timeoutMs?: number;
  loginUrl?: string;
  /** "msedge" | "chrome" | path to a chromium executable. Default: try Edge, then Chrome. */
  browser?: string;
  log?: (s: string) => void;
}

const USER_SELECTORS = [
  'input[name="Username"]',
  'input[name="UserName"]',
  'input[name="username"]',
  'input[name="Email"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[name*="user" i]',
  'input[name*="mail" i]',
  'input[type="text"]',
  'input[type="tel"]',
];
const PASS_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("ورود")',
  'button:has-text("ادامه")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  // Jobvision's sign-in page uses links styled as buttons
  'a:text-is("ادامه")',
  'a:text-is("ورود")',
  '[role=button]:has-text("ادامه")',
  '[role=button]:has-text("ورود")',
  'a:has-text("ادامه")',
];

const PASSWORD_OPTION = [
  'a:has-text("رمز عبور")',
  'button:has-text("رمز عبور")',
  'span:has-text("ورود با رمز")',
  'div[role=button]:has-text("رمز")',
  'a:has-text("password")',
  'button:has-text("password")',
  'a:has-text("Password")',
  'button:has-text("Password")',
].join(', ');

/** What the login page shows (fields, buttons, links) without any typed values, plus a screenshot. */
async function describePage(page: any): Promise<string> {
  const shot = path.resolve(
    process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : 'data',
    'login-error.png',
  );
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  // a string, not a function: tsx adds helpers to named inner functions that do not exist in the page
  const info = await page
    .evaluate(
      `(() => {
      const vis = (e) => !!(e.offsetParent || e.getClientRects().length);
      const t = (e) => (e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 50);
      return {
        inputs: [...document.querySelectorAll("input")].filter(vis).map((i) => i.type + (i.name ? " name=" + i.name : "") + (i.placeholder ? " «" + i.placeholder + "»" : "")),
        buttons: [...document.querySelectorAll("button, [role=button], input[type=submit]")].filter(vis).map(t).filter(Boolean),
        links: [...document.querySelectorAll("a")].filter(vis).map(t).filter(Boolean).slice(0, 15),
        next: [...document.querySelectorAll("a, button, [role=button]")].filter((e) => t(e) === "ادامه").map((e) =>
          e.outerHTML.replace(/value="[^"]*"/g, "").replace(/\\s+/g, " ").slice(0, 300)),
        captcha: !!document.querySelector("iframe[src*=captcha], [class*=captcha i], [id*=captcha i], iframe[src*=recaptcha], iframe[src*=arcaptcha]"),
        errors: [...document.querySelectorAll(".text-danger, .invalid-feedback, [role=alert], .error, .alert")].filter(vis).map(t).filter(Boolean),
      };
    })()`,
    )
    .catch(() => null);
  const url = String(page.url())
    .replace(/(access_token|id_token)=[^&]+/g, '$1=***')
    .slice(0, 300);
  return [
    `آدرس صفحه: ${url}`,
    info && `فیلدها: ${info.inputs.join(' | ') || '-'}`,
    info && `دکمه‌ها: ${info.buttons.join(' | ') || '-'}`,
    info && `لینک‌ها: ${info.links.join(' | ') || '-'}`,
    info?.next?.length && `دکمهٔ ادامه: ${info.next.join(' ')}`,
    info?.captcha && 'کپچا در صفحه هست',
    info?.errors?.length && `پیام خطا: ${info.errors.join(' | ')}`,
    `تصویر صفحه: ${shot}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The panel's own sign-in link: shows the email + password form and returns to the panel with a token. */
export function authorizeUrl(extra: Record<string, string> = {}): string {
  const rnd = () => randomBytes(16).toString('hex');
  const q = new URLSearchParams({
    ...extra,
    client_id: 'EmployerClient',
    redirect_uri: 'https://employer.jobvision.ir/auth-callback',
    response_type: 'id_token token',
    scope: 'openid profile JobVisionApi roles offline_access IdentityServerApi',
    nonce: rnd(),
    state: rnd(),
    role: 'employer',
  });
  return `https://account.jobvision.ir/connect/authorize?${q}`;
}

export async function launch(opts: LoginOptions) {
  const { chromium } = await import('playwright-core');
  const tries: { label: string; o: any }[] = [];
  const pref = opts.browser || process.env.BROWSER || '';
  if (pref && (pref.includes('/') || pref.includes('\\')))
    tries.push({ label: pref, o: { executablePath: pref } });
  else if (pref) tries.push({ label: pref, o: { channel: pref } });
  tries.push(
    { label: 'msedge', o: { channel: 'msedge' } },
    { label: 'chrome', o: { channel: 'chrome' } },
  );
  // Linux servers: system Chromium/Chrome, or Playwright's own Chromium (npx playwright install chromium)
  for (const p of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/opt/pw-browsers/chromium',
  ])
    if (fs.existsSync(p)) tries.push({ label: p, o: { executablePath: p } });
  tries.push({ label: 'playwright-chromium', o: {} });
  const errors: string[] = [];
  for (const t of tries) {
    try {
      return await chromium.launch({ ...t.o, headless: !opts.show, args: ['--no-sandbox'] });
    } catch (e) {
      errors.push(`${t.label}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `مرورگری برای ورود خودکار پیدا نشد (Edge یا Chrome لازم است).\n${errors.join('\n')}`,
  );
}

async function firstVisible(page: any, selectors: string[], timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const s of selectors) {
      const el = page.locator(s).first();
      if (await el.isVisible().catch(() => false)) return el;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/** Find an OIDC access token the SPA stored in session/local storage. */
async function tokenFromStorage(page: any): Promise<string | null> {
  return page
    .evaluate(() => {
      for (const store of [sessionStorage, localStorage]) {
        for (let i = 0; i < store.length; i++) {
          const v = store.getItem(store.key(i)!) ?? '';
          const m = v.match(/"access_token"\s*:\s*"([\w-]+\.[\w-]+\.[\w-]+)"/);
          if (m) return m[1];
        }
      }
      return null;
    })
    .catch(() => null);
}

export interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface LoginResult<T> {
  token: string;
  /** cookies of *.jobvision.ir after login (some file links need them) */
  cookies: SavedCookie[];
  after?: T;
}

/** Log in in a hidden browser; optionally keep using the logged-in browser (`after`) before it closes. */
export async function loginInBrowser<T = undefined>(
  opts: LoginOptions,
  after?: (ctx: any, page: any) => Promise<T>,
): Promise<LoginResult<T>> {
  const log = opts.log ?? (() => {});
  const timeout = opts.timeoutMs ?? (opts.show ? 180_000 : 60_000);
  if (!opts.email || !opts.password) throw new Error('ایمیل و رمز عبور جاب‌ویژن وارد نشده');
  const browser = await launch(opts);
  try {
    const ctx = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1280, height: 860 },
      acceptDownloads: true,
    });
    const page = await ctx.newPage();
    let token: string | null = null;
    page.on('request', (r: any) => {
      const h = r.headers()['authorization'];
      if (!token && h?.startsWith('Bearer ') && /employerapi\.jobvision\.ir/.test(r.url()))
        token = h.slice(7);
    });

    log('باز کردن صفحهٔ ورود…');
    // capture the token from the sign-in redirect too (…/auth-callback#access_token=…)
    page.on('framenavigated', (f: any) => {
      token ??= tokenFromUrl(f.url());
    });
    await page.goto(opts.loginUrl || process.env.JOBVISION_LOGIN_URL || authorizeUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Some panels show a landing page with a "login" link first
    let user = await firstVisible(page, USER_SELECTORS, 15_000);
    if (!user) {
      const link = page
        .locator(
          'a:has-text("ورود"), button:has-text("ورود"), a[href*="login" i], a[href*="account" i]',
        )
        .first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        user = await firstVisible(page, USER_SELECTORS, 20_000);
      }
    }
    if (!user) throw new Error(`فرم ورود پیدا نشد\n${await describePage(page)}`);
    log('وارد کردن ایمیل…');
    // type it like a person: some forms only enable «ادامه» after real key presses
    await user.click().catch(() => {});
    await user.fill('');
    await user.pressSequentially(opts.email, { delay: 40 });
    await user.dispatchEvent('change').catch(() => {});
    await user.evaluate((e: any) => e.blur()).catch(() => {});

    let pass = await firstVisible(page, PASS_SELECTORS, 1_500);
    if (!pass) {
      // two-step form: email first, then password
      const next = await firstVisible(page, SUBMIT_SELECTORS, 3_000);
      if (next) {
        log(
          `کلیک روی «${((await next.textContent().catch(() => '')) || 'ادامه').trim().slice(0, 20)}»…`,
        );
        await next
          .click({ timeout: 5_000 })
          .catch(() => next.click({ force: true, timeout: 5_000 }).catch(() => {}));
      } else await user.press('Enter');
      pass = await firstVisible(page, PASS_SELECTORS, 8_000);
      if (!pass) {
        log('رمز ظاهر نشد؛ امتحان با Enter…');
        await user.press('Enter').catch(() => {});
        pass = await firstVisible(page, PASS_SELECTORS, 8_000);
      }
    }
    if (!pass) {
      // the site may default to an SMS code and offer "log in with password" as a link/button
      const withPassword = page.locator(PASSWORD_OPTION).first();
      if (await withPassword.isVisible({ timeout: 5_000 }).catch(() => false)) {
        log('انتخاب «ورود با رمز عبور»…');
        await withPassword.click().catch(() => {});
        pass = await firstVisible(page, PASS_SELECTORS, 15_000);
      }
    }
    if (!pass)
      throw new Error(
        `فیلد رمز عبور پیدا نشد (ممکن است ورود با کد پیامکی باشد؛ با گزینهٔ «نمایش مرورگر» امتحان کنید)\n${await describePage(page)}`,
      );
    log('وارد کردن رمز عبور…');
    await pass.fill(opts.password);
    const submit = await firstVisible(page, SUBMIT_SELECTORS, 3_000);
    if (submit) await submit.click();
    else await pass.press('Enter');

    log(opts.show ? 'منتظر ورود… اگر کد یا کپچا خواست، در پنجرهٔ مرورگر وارد کنید.' : 'منتظر ورود…');
    const end = Date.now() + timeout;
    while (!token && Date.now() < end) {
      token = await tokenFromStorage(page);
      if (token) break;
      const err = await page
        .locator('.validation-summary-errors, .text-danger, .alert-danger, [role=alert]')
        .first()
        .textContent({ timeout: 200 })
        .catch(() => null);
      if (err?.trim()) throw new Error(`جاب‌ویژن خطا داد: ${err.trim()}`);
      await page.waitForTimeout(500);
    }
    if (!token) {
      const shot = path.resolve('data', 'login-error.png');
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot }).catch(() => {});
      throw new Error(
        `ورود انجام نشد (توکن دریافت نشد). تصویر صفحه: ${shot}\nاگر کپچا یا کد تأیید دارد، با «نمایش مرورگر» امتحان کنید.`,
      );
    }
    log('ورود موفق ✔');
    const result: LoginResult<T> = { token, cookies: await jobvisionCookies(ctx) };
    if (after) {
      await injectToken(ctx, token); // in case the panel did not take the sign-in redirect itself
      result.after = await after(ctx, page);
      result.cookies = await jobvisionCookies(ctx); // may have grown while using the panel
    }
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** The panel (oidc-client) keeps the logged-in user in sessionStorage; put our token there for every page. */
async function injectToken(ctx: any, token: string) {
  const exp = (() => {
    try {
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
    } catch {
      return Math.floor(Date.now() / 1000) + 3600;
    }
  })();
  const user = JSON.stringify({
    access_token: token,
    token_type: 'Bearer',
    expires_at: exp,
    scope: 'openid profile JobVisionApi',
    profile: {},
  });
  await ctx.addInitScript(
    ([key, value]: string[]) => {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    ['oidc.user:https://account.jobvision.ir:EmployerClient', user],
  );
}

export async function jobvisionCookies(ctx: any): Promise<SavedCookie[]> {
  const all: any[] = await ctx.cookies().catch(() => []);
  return all
    .filter((c) => /jobvision|127\.0\.0\.1|localhost/.test(c.domain))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
}

/** Put saved cookies back into a browser (so Jobvision remembers the earlier login). */
export async function restoreCookies(ctx: any, cookies: SavedCookie[]) {
  const ok = cookies
    .filter((c) => c.name && c.domain)
    .map((c) => ({
      ...c,
      path: c.path || '/',
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
    }));
  for (const c of ok) await ctx.addCookies([c]).catch(() => {});
}

/** Read the access token from a sign-in redirect URL (…#access_token=…). */
export function tokenFromUrl(url: string): string | null {
  return String(url).match(/[#&]access_token=([\w-]+\.[\w-]+\.[\w-]+)/)?.[1] ?? null;
}

/**
 * Get a fresh token without typing anything (no captcha): Jobvision's sign-in remembers this browser by
 * its cookies, so asking for a token with prompt=none returns one while that sign-in session lasts.
 * Returns null when the session has ended and someone has to log in again.
 */
export async function renewWithCookies(opts: {
  cookies: SavedCookie[];
  browser?: string;
  authorize?: string;
}): Promise<{ token: string; cookies: SavedCookie[] } | null> {
  if (!opts.cookies.length) return null;
  const browser = await launch({ email: '', password: '', browser: opts.browser });
  try {
    const ctx = await browser.newContext({ locale: 'fa-IR' });
    await restoreCookies(ctx, opts.cookies);
    const page = await ctx.newPage();
    let token: string | null = null;
    page.on('framenavigated', (f: any) => (token ??= tokenFromUrl(f.url())));
    await page
      .goto(opts.authorize ?? authorizeUrl({ prompt: 'none' }), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      .catch(() => {});
    const end = Date.now() + 20_000;
    while (!token && Date.now() < end) {
      token = tokenFromUrl(page.url());
      if (/[#&?]error=/.test(page.url())) break; // login_required: the session ended
      await page.waitForTimeout(300);
    }
    return token ? { token, cookies: await jobvisionCookies(ctx) } : null;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Open a browser that is already "logged in" by handing the panel our token (when no password is saved). */
export async function browserWithToken<T>(
  opts: { token: string; panelBase: string; browser?: string; cookies?: SavedCookie[] },
  fn: (ctx: any, page: any) => Promise<T>,
): Promise<{ after: T; cookies: SavedCookie[] }> {
  const browser = await launch({ email: '', password: '', browser: opts.browser });
  try {
    const ctx = await browser.newContext({
      locale: 'fa-IR',
      viewport: { width: 1280, height: 860 },
      acceptDownloads: true,
    });
    await injectToken(ctx, opts.token);
    if (opts.cookies) await restoreCookies(ctx, opts.cookies);
    const page = await ctx.newPage();
    const after = await fn(ctx, page);
    return { after, cookies: await jobvisionCookies(ctx) };
  } finally {
    await browser.close().catch(() => {});
  }
}
