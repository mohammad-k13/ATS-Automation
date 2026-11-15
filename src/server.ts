import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadCriteria, pickCriteria } from "./criteria.js";
import { Db } from "./db.js";
import { runOnce, type RunSummary } from "./pipeline.js";
import { anthropicComplete, KeywordScorer, LlmScorer, openAICompatComplete, type Scorer } from "./score.js";
import { loadSources } from "./sources/index.js";
import { JobvisionSource, jwtExpiry } from "./sources/jobvision-source.js";
import { ConsoleNotifier, TelegramNotifier, type Notifier } from "./telegram.js";
import type { Source } from "./types.js";

const env = process.env;
const PORT = Number(env.PORT || 3000);
const PUBLIC_DIR = path.resolve("public");
const db = new Db(env.DB_PATH || "data/ats.db");

// ---------- helpers ----------
function sources(): Source[] {
  return loadSources(env.SOURCES_FILE || "sources.yaml");
}
function source(name: string): Source {
  const s = sources().find((x) => x.name === name);
  if (!s) throw new HttpError(404, `Unknown platform "${name}". Check sources.yaml (enabled: true).`);
  return s;
}
function jobvision(name: string): JobvisionSource {
  const s = source(name);
  if (!(s instanceof JobvisionSource)) throw new HttpError(400, `${name} is not a Jobvision source`);
  return s;
}
export function aiInfo(): { provider: string; model: string | null } {
  const provider = (env.AI_PROVIDER || (env.OMNIROUTE_BASE_URL ? "omniroute" : env.ANTHROPIC_API_KEY ? "anthropic" : "")).toLowerCase();
  if (provider === "omniroute" && env.OMNIROUTE_BASE_URL && env.OMNIROUTE_MODEL) return { provider, model: env.OMNIROUTE_MODEL };
  if (provider === "anthropic" && env.ANTHROPIC_API_KEY) return { provider, model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5" };
  return { provider: "keyword", model: null };
}
function scorer(): Scorer {
  const ai = aiInfo();
  if (ai.provider === "omniroute") return new LlmScorer(openAICompatComplete(env.OMNIROUTE_BASE_URL!, env.OMNIROUTE_API_KEY ?? "", ai.model!));
  if (ai.provider === "anthropic") return new LlmScorer(anthropicComplete(env.ANTHROPIC_API_KEY!, ai.model!));
  return new KeywordScorer();
}
function notifier(sendTelegram: boolean): Notifier {
  if (sendTelegram && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    return new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.TELEGRAM_PROXY || undefined);
  return new ConsoleNotifier();
}
function tokenEnvName(src: string) {
  return `${src.toUpperCase()}_TOKEN`;
}
function tokenInfo(src: string) {
  const raw = (env[tokenEnvName(src)] ?? "").replace(/^Bearer\s+/i, "").trim();
  const exp = raw ? jwtExpiry(raw) : null;
  return { hasToken: !!raw, expiresAt: exp?.toISOString() ?? null, valid: !!exp && exp.getTime() > Date.now() + 60_000 };
}
/** Replace (or add) KEY=value in .env and in process.env. */
function writeEnv(key: string, value: string) {
  const file = ".env";
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join("\n"));
  env[key] = value;
}
const parse = (s: string | null) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

// ---------- background sync ----------
interface SyncState {
  running: boolean;
  done: number;
  total: number;
  log: string[];
  startedAt: string;
  finishedAt?: string;
  summary?: { accepted: number; rejected: number; errors: number; skipped: number };
  error?: string;
}
const syncs = new Map<string, SyncState>();

async function startSync(src: string, jobId: string, opts: { rescore?: boolean; telegram?: boolean }) {
  const key = `${src}:${jobId}`;
  if (syncs.get(key)?.running) throw new HttpError(409, "A sync for this job is already running");
  const s = source(src);
  if (s instanceof JobvisionSource) s.onlyJobs = [Number(jobId)];
  if (opts.rescore) db.forgetJob(src, jobId);
  const st: SyncState = { running: true, done: 0, total: 0, log: [], startedAt: new Date().toISOString() };
  syncs.set(key, st);
  const log = (line: string) => {
    st.log.push(line);
    if (st.log.length > 300) st.log.shift();
    console.log(`[${key}] ${line}`);
  };
  runOnce({
    sources: [s],
    criteria: loadCriteria(env.CRITERIA_DIR || "criteria"),
    db,
    scorer: scorer(),
    notifier: notifier(!!opts.telegram),
    digest: false,
    log,
    onProgress: (d, t) => {
      st.done = d;
      st.total = t;
    },
  })
    .then((r: RunSummary) => {
      st.summary = { accepted: r.accepted.length, rejected: r.rejected.length, errors: r.errors.length, skipped: r.skipped };
      if (r.errors.length && !r.accepted.length && !r.rejected.length && r.errors[0] && !r.errors[0].app) st.error = r.errors[0].error;
      st.done = st.total;
    })
    .catch((e) => {
      st.error = e instanceof Error ? e.message : String(e);
      log(`✖ ${st.error}`);
    })
    .finally(() => {
      st.running = false;
      st.finishedAt = new Date().toISOString();
    });
}

// ---------- routes ----------
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
type Handler = (m: RegExpMatchArray, body: any, url: URL) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);

route("GET", "/api/status", () => ({
  ai: aiInfo(),
  telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  platforms: sources().map((s) => ({ name: s.name, type: s instanceof JobvisionSource ? "jobvision" : "other", token: tokenInfo(s.name) })),
}));

route("POST", "/api/platforms/:src/token", (m, body) => {
  const src = m.groups!.src;
  const tok = String(body?.token ?? "").trim();
  if (!tok) throw new HttpError(400, "token is empty");
  if (/[^\x21-\x7e ]/.test(tok)) throw new HttpError(400, 'Token contains invalid characters (e.g. "…") - it was copied truncated. Copy the full value.');
  const raw = tok.replace(/^Bearer\s+/i, "");
  if (raw.split(".").length !== 3) throw new HttpError(400, "That does not look like a full token (expected 3 parts separated by dots).");
  writeEnv(tokenEnvName(src), raw);
  return tokenInfo(src);
});

route("GET", "/api/platforms/:src/jobs", async (m) => {
  const src = m.groups!.src;
  const s = jobvision(src);
  const jobs = await s.listJobs();
  const stats = new Map(db.jobStats(src).map((x) => [x.job_id, x]));
  const criteria = loadCriteria(env.CRITERIA_DIR || "criteria");
  return jobs.map((j) => {
    const st = stats.get(j.id);
    const c = pickCriteria(criteria, { source: src, id: "", name: "", jobId: j.id, jobTitle: j.title });
    return {
      ...j,
      criteria: c ? { name: c.name, isDefault: c.name === "default" } : null,
      stats: st ? { total: st.total, accepted: st.accepted, rejected: st.rejected, errors: st.errors, avgScore: st.avg_score, lastProcessed: st.last_processed } : null,
      sync: syncs.get(`${src}:${j.id}`) ?? null,
    };
  });
});

route("GET", "/api/platforms/:src/jobs/:id/counts", async (m) => jobvision(m.groups!.src).jobCounts(m.groups!.id));

route("POST", "/api/platforms/:src/jobs/:id/sync", async (m, body) => {
  await startSync(m.groups!.src, m.groups!.id, { rescore: !!body?.rescore, telegram: !!body?.telegram });
  return syncs.get(`${m.groups!.src}:${m.groups!.id}`);
});

route("GET", "/api/platforms/:src/jobs/:id/sync", (m) => syncs.get(`${m.groups!.src}:${m.groups!.id}`) ?? { running: false, done: 0, total: 0, log: [] });

route("GET", "/api/platforms/:src/jobs/:id/applications", (m) =>
  db.listByJob(m.groups!.src, m.groups!.id).map((r) => ({
    id: r.id, name: r.name, job: r.job, decision: r.decision, score: r.score, error: r.error,
    result: parse(r.result_json), extra: parse(r.extra_json), profileUrl: r.profile_url, appliedAt: r.applied_at, processedAt: r.processed_at,
  })),
);

route("GET", "/api/platforms/:src/applications/:id", (m) => {
  const r = db.get(m.groups!.src, m.groups!.id);
  if (!r) throw new HttpError(404, "not found");
  return { ...r, result: parse(r.result_json), extra: parse(r.extra_json) };
});

// ---------- server ----------
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      let body: any = null;
      if (req.method === "POST") {
        let raw = "";
        for await (const c of req) raw += c;
        body = raw ? JSON.parse(raw) : {};
      }
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && method === req.method) {
          const out = await h(m, body, url);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify(out ?? null));
        }
      }
      throw new HttpError(404, "no such endpoint");
    }
    // static files
    const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, "index.html")));
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e as any)?.constructor?.name === "AuthError" ? 401 : 500;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 500) console.error(e);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`\n  ATS dashboard: http://localhost:${PORT}\n`));
