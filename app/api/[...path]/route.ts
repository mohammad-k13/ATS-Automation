import * as svc from "@/src/service";
import { AuthError } from "@/src/sources/http-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };
type H = (p: Record<string, string>, body: any, query: URLSearchParams) => unknown;

// [method, pattern, handler]  — :name captures a segment
const routes: [string, string, H][] = [
  ["GET", "status", () => svc.status()],
  ["GET", "sources", () => svc.readSourcesYaml()],
  ["PUT", "sources", (_, b) => svc.saveSourcesYaml(String(b?.text ?? ""))],
  ["POST", "platforms/:src/token", (p, b) => svc.setToken(p.src, String(b?.token ?? ""))],
  ["PUT", "platforms/:src/credentials", (p, b) => svc.setCredentials(p.src, String(b?.email ?? ""), b?.password ? String(b.password) : undefined)],
  ["POST", "platforms/:src/login", (p, b) => svc.loginNow(p.src, !!b?.show)],
  ["GET", "platforms/:src/jobs", (p) => svc.listJobs(p.src)],
  ["GET", "platforms/:src/jobs/:id/settings", (p) => svc.getJobSettings(p.src, p.id)],
  ["PUT", "platforms/:src/jobs/:id/criteria", (p, b) => svc.saveJobCriteria(p.src, p.id, b?.criteria, b?.jobTitle)],
  ["POST", "platforms/:src/jobs/:id/criteria/draft", (_, b) => svc.draftCriteria(String(b?.jobTitle ?? ""), String(b?.description ?? ""), b?.current ?? null)],
  ["PUT", "platforms/:src/jobs/:id/scheduled", (p, b) => (svc.setJobScheduled(p.src, p.id, !!b?.on), svc.getJobSettings(p.src, p.id))],
  ["POST", "platforms/:src/jobs/:id/refresh", (p) => svc.refreshApplications(p.src, p.id)],
  ["GET", "platforms/:src/jobs/:id/applications", (p) => svc.listApplications(p.src, p.id)],
  ["POST", "platforms/:src/jobs/:id/score", (p, b) => svc.startScoring(p.src, p.id, { ids: b?.ids, rescore: !!b?.rescore })],
  ["GET", "platforms/:src/jobs/:id/task", (p) => svc.getTask(p.src, p.id)],
  ["GET", "platforms/:src/jobs/:id/chat", (p) => svc.getChatHistory(p.src, p.id)],
  ["POST", "platforms/:src/jobs/:id/chat", (p, b) => svc.chatAboutJob(p.src, p.id, String(b?.message ?? ""), b?.focusIds ?? [])],
  ["DELETE", "platforms/:src/jobs/:id/chat", (p) => (svc.clearChat(p.src, p.id), [])],
  ["GET", "platforms/:src/applications/:id", (p) => svc.getApplication(p.src, p.id)],
  ["PUT", "platforms/:src/jobs/:id/unit", (p, b) => svc.setJobUnit(p.src, p.id, String(b?.unit ?? ""))],
  ["GET", "platforms/:src/report", (p, _b, q) => svc.report(p.src, { jobId: q.get("job") ?? undefined, status: q.get("status") ?? undefined, ids: q.get("ids") ?? undefined })],
  ["GET", "integrations", () => svc.getIntegrations()],
  ["PUT", "integrations/ai", (_, b) => svc.saveAiSettings(b ?? {})],
  ["POST", "integrations/ai/models", (_, b) => svc.listAiModels(b ?? {})],
  ["POST", "integrations/ai/test", () => svc.testAi()],
  ["PUT", "integrations/telegram", (_, b) => svc.saveTelegramSettings(b ?? {})],
  ["POST", "integrations/telegram/test", () => svc.testTelegram()],
];

function match(pattern: string, parts: string[]) {
  const pp = pattern.split("/");
  if (pp.length !== parts.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) out[pp[i].slice(1)] = decodeURIComponent(parts[i]);
    else if (pp[i] !== parts[i]) return null;
  }
  return out;
}

async function handle(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  try {
    const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json().catch(() => ({}));
    for (const [m, pat, h] of routes) {
      const p = m === req.method ? match(pat, path) : null;
      if (p) return Response.json((await h(p, body, new URL(req.url).searchParams)) ?? null);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    const status = e instanceof svc.UserError ? e.status : e instanceof AuthError ? 401 : 500;
    const msg = e instanceof AuthError ? "توکن منقضی یا نامعتبر است؛ از تنظیمات توکن جدید وارد کنید." : e instanceof Error ? e.message : String(e);
    if (status === 500) console.error(e);
    return Response.json({ error: msg }, { status });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
