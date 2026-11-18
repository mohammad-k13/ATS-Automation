/**
 * Log in to Jobvision by hand from the dashboard, for when the login page has a captcha.
 * The server runs the browser; the dashboard shows it as a picture and forwards clicks and typing.
 * When the panel hands back a token, the token and the sign-in cookies are saved, so later tokens can be
 * renewed without anyone typing (see renewWithCookies).
 */
import { authorizeUrl, jobvisionCookies, launch, restoreCookies, tokenFromUrl, type SavedCookie } from "./jobvision-login";

export const VIEW = { width: 1000, height: 760 };
const IDLE_MS = 10 * 60_000;

interface Session {
  src: string;
  browser: any;
  ctx: any;
  page: any;
  token: string | null;
  done: boolean;
  error: string | null;
  lastUsed: number;
  onDone: (token: string, cookies: SavedCookie[]) => void;
}

const g = globalThis as unknown as { __atsRemote?: Session | null };

async function close(s: Session) {
  if (g.__atsRemote === s) g.__atsRemote = null;
  await s.browser.close().catch(() => {});
}

function current(src: string): Session {
  const s = g.__atsRemote;
  if (!s || s.src !== src) throw new Error("پنجرهٔ ورود باز نیست؛ دوباره «ورود دستی» را بزنید");
  s.lastUsed = Date.now();
  return s;
}

export async function startRemoteLogin(opts: {
  src: string;
  email?: string;
  cookies?: SavedCookie[];
  loginUrl?: string;
  onDone: (token: string, cookies: SavedCookie[]) => void;
}) {
  if (g.__atsRemote) await close(g.__atsRemote);
  const browser = await launch({ email: "", password: "" });
  const ctx = await browser.newContext({ locale: "fa-IR", viewport: VIEW });
  if (opts.cookies?.length) await restoreCookies(ctx, opts.cookies);
  const page = await ctx.newPage();
  const s: Session = { src: opts.src, browser, ctx, page, token: null, done: false, error: null, lastUsed: Date.now(), onDone: opts.onDone };
  g.__atsRemote = s;

  const finish = async (token: string) => {
    if (s.done) return;
    s.token = token;
    s.done = true;
    await page.waitForTimeout(1_500).catch(() => {}); // let the panel set its cookies
    try {
      s.onDone(token, await jobvisionCookies(ctx));
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
    }
    setTimeout(() => close(s), 3_000);
  };
  page.on("framenavigated", (f: any) => {
    const t = tokenFromUrl(f.url());
    if (t) void finish(t);
  });
  page.on("request", (r: any) => {
    const h = r.headers()["authorization"];
    if (h?.startsWith("Bearer ") && /employerapi\.jobvision\.ir/.test(r.url())) void finish(h.slice(7));
  });
  const idle = setInterval(() => {
    if (s.done || Date.now() - s.lastUsed > IDLE_MS) {
      clearInterval(idle);
      if (!s.done) void close(s);
    }
  }, 30_000);

  await page.goto(opts.loginUrl ?? authorizeUrl(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  // put the email in for them; they only solve the captcha and continue
  if (opts.email) {
    const user = page.locator('input[name="username"], input[name="Username"], input[type="email"]').first();
    if (await user.isVisible({ timeout: 5_000 }).catch(() => false)) await user.fill(opts.email).catch(() => {});
  }
  return status(opts.src);
}

export function status(src: string) {
  const s = g.__atsRemote;
  if (!s || s.src !== src) return { open: false, done: false, error: null as string | null };
  return { open: true, done: s.done, error: s.error };
}

export async function screenshot(src: string): Promise<Uint8Array> {
  const s = current(src);
  return s.page.screenshot({ type: "jpeg", quality: 70 });
}

/** x, y are 0..1 of the picture */
export async function click(src: string, x: number, y: number) {
  const s = current(src);
  await s.page.mouse.click(Math.round(x * VIEW.width), Math.round(y * VIEW.height));
}

export async function type(src: string, text: string) {
  const s = current(src);
  await s.page.keyboard.type(text, { delay: 30 });
}

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp"]);
export async function press(src: string, key: string) {
  if (!KEYS.has(key)) throw new Error("کلید نامعتبر");
  const s = current(src);
  await s.page.keyboard.press(key);
}

export async function cancel(src: string) {
  const s = g.__atsRemote;
  if (s && s.src === src) await close(s);
}
