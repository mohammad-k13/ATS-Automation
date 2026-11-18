import "dotenv/config";
import "./settings-store"; // saved dashboard settings override .env
import { parseArgs } from "node:util";
import cron from "node-cron";
import { loadCriteria } from "./criteria";
import { Db } from "./db";
import { runOnce } from "./pipeline";
import { aiInfo, getScorer } from "./ai";
import { ensureToken, hasCredentials, loginAndSave, saveCredentials, tokenInfo } from "./auth/token";
import { KeywordScorer, type Scorer } from "./score";
import { loadSources } from "./sources/index";
import { HttpSource } from "./sources/http-source";
import { JobvisionSource } from "./sources/jobvision-source";
import type { Source } from "./types";
import { ConsoleNotifier, TelegramNotifier, type Notifier } from "./telegram";

const env = process.env;
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string", short: "s" },
    "dry-run": { type: "boolean", default: false },
    "no-llm": { type: "boolean", default: false },
    show: { type: "boolean", default: false },
    email: { type: "string" },
    password: { type: "string" },
    limit: { type: "string", default: "30" },
  },
});
const [cmd = "help", arg1, arg2] = positionals;

function makeScorer(): Scorer {
  if (flags["no-llm"]) return new KeywordScorer();
  const ai = aiInfo();
  console.log(ai.provider === "keyword" ? "ℹ Using keyword-only scoring (no AI configured)." : `ℹ Scoring with ${ai.provider} (${ai.model})`);
  return getScorer();
}

function makeNotifier(dry: boolean): Notifier {
  if (dry) return new ConsoleNotifier();
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("ℹ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: printing to console instead.");
    return new ConsoleNotifier();
  }
  return new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.TELEGRAM_PROXY || undefined);
}

async function run() {
  const dry = flags["dry-run"]!;
  // refresh expired tokens automatically when email/password are saved
  for (const s of loadSources(env.SOURCES_FILE || "sources.yaml", flags.source)) {
    if (!(s instanceof JobvisionSource)) continue;
    if (!tokenInfo(s.name).valid && hasCredentials(s.name)) {
      console.log(`🔑 ${s.name}: token expired, logging in…`);
      await ensureToken(s.name, { log: (l) => console.log("   " + l) });
    }
  }
  return runOnce({
    sources: loadSources(env.SOURCES_FILE || "sources.yaml", flags.source),
    criteria: loadCriteria(env.CRITERIA_DIR || "criteria"),
    db: new Db(env.DB_PATH || "data/ats.db"),
    scorer: makeScorer(),
    notifier: makeNotifier(dry),
    dryRun: dry,
    digest: env.TELEGRAM_DIGEST !== "false",
  });
}

async function main() {
  switch (cmd) {
    case "run":
      await run();
      break;

    case "schedule": {
      const expr = env.SCHEDULE_CRON || "*/20 * * * *";
      if (!cron.validate(expr)) throw new Error(`Invalid SCHEDULE_CRON: ${expr}`);
      let running = false;
      const tick = async () => {
        if (running) return console.log("previous run still in progress, skipping tick");
        running = true;
        console.log(`\n[${new Date().toISOString()}] run`);
        try {
          await run();
        } catch (e) {
          console.error(e);
        } finally {
          running = false;
        }
      };
      console.log(`Scheduler started: "${expr}". Ctrl+C to stop.`);
      await tick();
      cron.schedule(expr, tick);
      break;
    }

    case "probe": {
      // Show what a source returns, to check config/field mapping. Read-only.
      const name = arg1 ?? flags.source;
      const [src]: Source[] = loadSources(env.SOURCES_FILE || "sources.yaml", name);
      if (!src) throw new Error(`No source named "${name}" in sources.yaml`);
      if (src instanceof HttpSource) {
        const json = await src.fetchPage(Number(arg2 ?? 1));
        console.log("=== RAW (first 3000 chars) ===\n" + JSON.stringify(json, null, 2).slice(0, 3000));
      }
      const apps = await src.listApplications();
      console.log(`\n=== ${apps.length} application(s), first 3 ===`);
      console.log(JSON.stringify(apps.slice(0, 3).map(({ raw, ...a }) => a), null, 2));
      const getText = (src as Source).getResumeText?.bind(src);
      if (apps[0] && getText) console.log(`\n=== Resume text of "${apps[0].name}" (what the scorer sees) ===\n` + (await getText(apps[0])));
      break;
    }

    case "list":
      console.table(new Db(env.DB_PATH || "data/ats.db").list(Number(flags.limit)).map(({ source, id, name, job, decision, score, processed_at }) => ({ source, id, name, job, decision, score, processed_at })));
      break;

    case "forget": // re-process: forget <source> [id]
      if (!arg1) throw new Error("usage: forget <source> [id]");
      new Db(env.DB_PATH || "data/ats.db").forget(arg1, arg2);
      console.log("forgotten; next run will re-score");
      break;

    case "passwd": {
      // Set the dashboard login: npm run ats -- passwd <user>   (password from ATS_NEW_PASSWORD or typed in)
      const user = arg1 || "admin";
      let pw = env.ATS_NEW_PASSWORD ?? "";
      if (!pw) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        pw = await rl.question(`New dashboard password for "${user}": `);
        rl.close();
      }
      if (pw.length < 8) throw new Error("Password must be at least 8 characters");
      const { hashPassword } = await import("./auth/session");
      const { writeEnv } = await import("./auth/token");
      const { randomBytes } = await import("node:crypto");
      writeEnv("ATS_USER", user);
      writeEnv("ATS_PASSWORD_HASH", hashPassword(pw));
      if (!env.ATS_SECRET) writeEnv("ATS_SECRET", randomBytes(32).toString("base64url"));
      console.log(`✔ dashboard login set for "${user}". Restart the dashboard to apply.`);
      break;
    }

    case "login": {
      // npm run ats -- login jobvision [--email x --password y] [--show]
      const src = arg1 || "jobvision";
      if (flags.email || flags.password) saveCredentials(src, flags.email ?? "", flags.password);
      if (!hasCredentials(src)) throw new Error(`Save credentials first: npm run ats -- login ${src} --email you@company.com --password "..."`);
      await loginAndSave(src, { show: flags.show, log: (l) => console.log(l) });
      const t = tokenInfo(src);
      console.log(`✔ token saved to .env, valid until ${t.expiresAt}`);
      break;
    }

    case "test-ai": {
      const sc = makeScorer();
      const r = await sc.score({ source: "test", id: "1", name: "Test", jobTitle: "Backend Developer" },
        "Backend developer, 4 years Node.js, TypeScript and PostgreSQL at an e-commerce company.",
        { name: "test", match: {}, threshold: 70, partialThreshold: 50, mustHave: ["Node.js", "PostgreSQL"], niceToHave: ["Docker"], hardFilters: {} });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case "test-telegram":
      await makeNotifier(false).sendText("✅ ATS bot is connected.");
      console.log("sent");
      break;

    default:
      console.log(`Usage:
  npm run ats -- run [--source NAME] [--dry-run] [--no-llm]   Fetch, score, send accepted to Telegram
  npm run ats -- schedule                                    Run now and then on SCHEDULE_CRON
  npm run ats -- probe NAME [page]                           Inspect an endpoint response + field mapping
  npm run ats -- list [--limit 30]                           Show processed applications
  npm run ats -- forget SOURCE [ID]                          Re-process an application (or whole source)
  npm run ats -- login jobvision [--email E --password P] [--show]   Log in and save a fresh token
  npm run ats -- test-ai                                     Score a sample resume with your AI setup
  npm run ats -- test-telegram                               Send a test message`);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
