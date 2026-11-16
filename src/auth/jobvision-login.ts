/**
 * Log in to the Jobvision employer panel with email + password using the browser already on this
 * machine (Edge or Chrome) and capture the API token the panel uses.
 * Nothing is downloaded: playwright-core drives the installed browser.
 */
import fs from "node:fs";
import path from "node:path";

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
  'input[name="Username"]', 'input[name="UserName"]', 'input[name="username"]', 'input[name="Email"]', 'input[name="email"]',
  'input[type="email"]', 'input[autocomplete="username"]', 'input[name*="user" i]', 'input[name*="mail" i]', 'input[type="text"]', 'input[type="tel"]',
];
const PASS_SELECTORS = ['input[type="password"]'];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]', 'button:has-text("ورود")', 'button:has-text("ادامه")', 'button:has-text("Login")', 'button:has-text("Sign in")',
];

async function launch(opts: LoginOptions) {
  const { chromium } = await import("playwright-core");
  const tries: { label: string; o: any }[] = [];
  const pref = opts.browser || process.env.BROWSER || "";
  if (pref && (pref.includes("/") || pref.includes("\\"))) tries.push({ label: pref, o: { executablePath: pref } });
  else if (pref) tries.push({ label: pref, o: { channel: pref } });
  tries.push({ label: "msedge", o: { channel: "msedge" } }, { label: "chrome", o: { channel: "chrome" } });
  if (fs.existsSync("/opt/pw-browsers/chromium")) tries.push({ label: "chromium", o: { executablePath: "/opt/pw-browsers/chromium" } });
  const errors: string[] = [];
  for (const t of tries) {
    try {
      return await chromium.launch({ ...t.o, headless: !opts.show, args: ["--no-sandbox"] });
    } catch (e) {
      errors.push(`${t.label}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`مرورگری برای ورود خودکار پیدا نشد (Edge یا Chrome لازم است).\n${errors.join("\n")}`);
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
          const v = store.getItem(store.key(i)!) ?? "";
          const m = v.match(/"access_token"\s*:\s*"([\w-]+\.[\w-]+\.[\w-]+)"/);
          if (m) return m[1];
        }
      }
      return null;
    })
    .catch(() => null);
}

export async function jobvisionLogin(opts: LoginOptions): Promise<string> {
  const log = opts.log ?? (() => {});
  const timeout = opts.timeoutMs ?? (opts.show ? 180_000 : 60_000);
  if (!opts.email || !opts.password) throw new Error("ایمیل و رمز عبور جاب‌ویژن وارد نشده");
  const browser = await launch(opts);
  try {
    const ctx = await browser.newContext({ locale: "fa-IR", viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    let token: string | null = null;
    page.on("request", (r: any) => {
      const h = r.headers()["authorization"];
      if (!token && h?.startsWith("Bearer ") && /employerapi\.jobvision\.ir/.test(r.url())) token = h.slice(7);
    });

    log("باز کردن صفحهٔ ورود…");
    await page.goto(opts.loginUrl || process.env.JOBVISION_LOGIN_URL || "https://employer.jobvision.ir/", { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Some panels show a landing page with a "login" link first
    let user = await firstVisible(page, USER_SELECTORS, 15_000);
    if (!user) {
      const link = page.locator('a:has-text("ورود"), button:has-text("ورود"), a[href*="login" i], a[href*="account" i]').first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        user = await firstVisible(page, USER_SELECTORS, 20_000);
      }
    }
    if (!user) throw new Error("فرم ورود پیدا نشد");
    log("وارد کردن ایمیل…");
    await user.fill(opts.email);

    let pass = await firstVisible(page, PASS_SELECTORS, 1_500);
    if (!pass) {
      // two-step form: email first, then password
      const next = await firstVisible(page, SUBMIT_SELECTORS, 3_000);
      if (next) await next.click();
      pass = await firstVisible(page, PASS_SELECTORS, 20_000);
    }
    if (!pass) throw new Error("فیلد رمز عبور پیدا نشد (ممکن است ورود با کد پیامکی باشد؛ با گزینهٔ «نمایش مرورگر» امتحان کنید)");
    log("وارد کردن رمز عبور…");
    await pass.fill(opts.password);
    const submit = await firstVisible(page, SUBMIT_SELECTORS, 3_000);
    if (submit) await submit.click();
    else await pass.press("Enter");

    log(opts.show ? "منتظر ورود… اگر کد یا کپچا خواست، در پنجرهٔ مرورگر وارد کنید." : "منتظر ورود…");
    const end = Date.now() + timeout;
    while (!token && Date.now() < end) {
      token = await tokenFromStorage(page);
      if (token) break;
      const err = await page.locator(".validation-summary-errors, .text-danger, .alert-danger, [role=alert]").first().textContent({ timeout: 200 }).catch(() => null);
      if (err?.trim()) throw new Error(`جاب‌ویژن خطا داد: ${err.trim()}`);
      await page.waitForTimeout(500);
    }
    if (!token) {
      const shot = path.resolve("data", "login-error.png");
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot }).catch(() => {});
      throw new Error(`ورود انجام نشد (توکن دریافت نشد). تصویر صفحه: ${shot}\nاگر کپچا یا کد تأیید دارد، با «نمایش مرورگر» امتحان کنید.`);
    }
    log("ورود موفق ✔");
    return token;
  } finally {
    await browser.close().catch(() => {});
  }
}
