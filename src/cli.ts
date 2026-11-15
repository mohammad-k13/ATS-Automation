import "dotenv/config";
import { parseArgs } from "node:util";
import cron from "node-cron";
import { loadCriteria } from "./criteria.js";
import { Db } from "./db.js";
import { runOnce } from "./pipeline.js";
import { KeywordScorer, LlmScorer, type Scorer } from "./score.js";
import { loadSources } from "./sources/index.js";
import { HttpSource } from "./sources/http-source.js";
import type { Source } from "./types.js";
import { ConsoleNotifier, TelegramNotifier, type Notifier } from "./telegram.js";

const env = process.env;
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string", short: "s" },
    "dry-run": { type: "boolean", default: false },
    "no-llm": { type: "boolean", default: false },
    limit: { type: "string", default: "30" },
  },
});
const [cmd = "help", arg1, arg2] = positionals;

function makeScorer(): Scorer {
  if (!flags["no-llm"] && env.ANTHROPIC_API_KEY) return new LlmScorer(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
  console.log("ℹ Using keyword-only scoring (no ANTHROPIC_API_KEY or --no-llm).");
  return new KeywordScorer();
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
  npm run ats -- test-telegram                               Send a test message`);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
