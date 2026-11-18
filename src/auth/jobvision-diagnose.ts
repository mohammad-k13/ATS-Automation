/**
 * Find out how the Jobvision panel downloads a candidate's attached resume, by doing it in a hidden
 * browser on this server: open the applicant's profile, click the download icon, and record what the
 * browser sends to the file server. Only header and cookie NAMES are recorded, never their values.
 */
import { browserWithToken, loginInBrowser, type SavedCookie } from "./jobvision-login";

export interface CapturedRequest {
  method: string;
  url: string; // query values that look like secrets are replaced
  headers: string[]; // header names
  cookies: string[]; // cookie names sent
  status: number | null;
  contentType: string | null;
  bytes: number | null;
}

export interface Diagnosis {
  loggedInWith: "password" | "token";
  profileOpened: boolean;
  clicked: boolean;
  requests: CapturedRequest[];
  direct: { status: number | null; contentType: string | null }; // opening the file link in a tab
  cookies: SavedCookie[];
  cookieNames: string[];
}

const hide = (u: string) => u.replace(/([?&](?:access_token|token|key|sig|signature)=)[^&]+/gi, "$1***");
const FILEISH = /fileapi\.|\/files?\/|download/i;

export async function diagnoseAttachment(opts: {
  email?: string;
  password?: string;
  token: string;
  panelBase: string; // https://employer.jobvision.ir
  profileUrl: string; // applicant page that shows the download icon
  fileUrl: string; // the plain link from the API
  log?: (s: string) => void;
}): Promise<Diagnosis> {
  const log = opts.log ?? (() => {});
  const requests: CapturedRequest[] = [];
  const byReq = new Map<any, CapturedRequest>();

  const work = async (ctx: any, page: any) => {
    ctx.on("request", (r: any) => {
      const url = r.url();
      if (!FILEISH.test(url) || /\.(svg|png|jpg|css|js|woff2?)(\?|$)/i.test(url)) return;
      const h = r.headers();
      const c: CapturedRequest = {
        method: r.method(),
        url: hide(url),
        headers: Object.keys(h).filter((k) => !k.startsWith(":")).sort(),
        cookies: (h["cookie"] ?? "").split(/;\s*/).map((x: string) => x.split("=")[0]).filter(Boolean),
        status: null,
        contentType: null,
        bytes: null,
      };
      requests.push(c);
      byReq.set(r, c);
    });
    ctx.on("response", async (res: any) => {
      const c = byReq.get(res.request());
      if (!c) return;
      c.status = res.status();
      c.contentType = res.headers()["content-type"] ?? null;
      c.bytes = Number(res.headers()["content-length"] ?? NaN) || null;
      // headers() leaves out Cookie and other security headers; allHeaders() has what was really sent
      const h = await res.request().allHeaders().catch(() => null);
      if (h) {
        c.headers = Object.keys(h).filter((k) => !k.startsWith(":")).sort();
        c.cookies = (h["cookie"] ?? "").split(/;\s*/).map((x: string) => x.split("=")[0]).filter(Boolean);
      }
    });

    let profileOpened = false;
    let clicked = false;
    log("باز کردن صفحهٔ کارجو در پنل…");
    try {
      await page.goto(opts.profileUrl, { waitUntil: "networkidle", timeout: 45_000 });
      profileOpened = true;
    } catch {
      profileOpened = page.url().includes("/applications/");
    }
    if (profileOpened) {
      const icon = page.locator('img[src*="download-primary"], a[href*="Files/Download"], button:has(img[src*="download"])').first();
      if (await icon.isVisible({ timeout: 15_000 }).catch(() => false)) {
        log("کلیک روی آیکون دانلود فایل پیوست…");
        const popup = ctx.waitForEvent("page", { timeout: 8_000 }).catch(() => null);
        const download = page.waitForEvent("download", { timeout: 8_000 }).catch(() => null);
        await icon.click().catch(() => {});
        clicked = true;
        const [p, d] = await Promise.all([popup, download]);
        if (p) await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        if (d) log("مرورگر فایل را دانلود کرد");
        await page.waitForTimeout(2_000);
      } else log("آیکون دانلود در صفحه پیدا نشد");
    }

    log("باز کردن مستقیم لینک فایل در یک برگهٔ جدید…");
    const tab = await ctx.newPage();
    const res = await tab.goto(opts.fileUrl, { timeout: 30_000 }).catch(() => null);
    const direct = { status: res?.status() ?? null, contentType: res?.headers()["content-type"] ?? null };
    await tab.close().catch(() => {});
    return { profileOpened, clicked, direct };
  };

  let r: { after: Awaited<ReturnType<typeof work>>; cookies: SavedCookie[] };
  let loggedInWith: Diagnosis["loggedInWith"];
  let out: Awaited<ReturnType<typeof loginInBrowser<Awaited<ReturnType<typeof work>>>>> | null = null;
  if (opts.email && opts.password)
    try {
      out = await loginInBrowser({ email: opts.email, password: opts.password, log }, work);
    } catch (e) {
      log(`ورود با رمز نشد، با توکن ادامه می‌دهم: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
  if (out) {
    r = { after: out.after!, cookies: out.cookies };
    loggedInWith = "password";
  } else {
    log("ایمیل و رمز ذخیره نشده؛ ورود با توکن فعلی…");
    r = await browserWithToken({ token: opts.token, panelBase: opts.panelBase }, work);
    loggedInWith = "token";
  }
  return {
    loggedInWith,
    profileOpened: r.after.profileOpened,
    clicked: r.after.clicked,
    requests,
    direct: r.after.direct,
    cookies: r.cookies,
    cookieNames: [...new Set(r.cookies.map((c) => `${c.name} (${c.domain})`))],
  };
}
