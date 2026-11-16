import { pickCriteria } from "./criteria";
import type { Db } from "./db";
import { resumeToText } from "./parse";
import type { Scorer } from "./score";
import { AuthError } from "./sources/http-source";
import type { Notifier } from "./telegram";
import type { Application, Criteria, ResumeFile, Source } from "./types";
import { escapeHtml } from "./util";

export interface RunOptions {
  sources: Source[];
  criteria: Criteria[];
  db: Db;
  scorer: Scorer;
  notifier: Notifier;
  dryRun?: boolean;
  digest?: boolean;
  log?: (s: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface RunSummary {
  accepted: { app: Application; score: number }[];
  rejected: { app: Application; score?: number; reason: string }[];
  errors: { app?: Application; source: string; error: string }[];
  skipped: number;
}

export async function runOnce(o: RunOptions): Promise<RunSummary> {
  const log = o.log ?? console.log;
  const sum: RunSummary = { accepted: [], rejected: [], errors: [], skipped: 0 };

  for (const src of o.sources) {
    let apps: Application[];
    try {
      apps = await src.listApplications();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sum.errors.push({ source: src.name, error: msg });
      log(`✖ ${src.name}: ${msg}`);
      if (e instanceof AuthError && !o.dryRun) await o.notifier.sendText(`🔐 <b>${escapeHtml(src.name)}</b>: ${escapeHtml(msg)}`).catch(() => {});
      continue;
    }
    log(`${src.name}: ${apps.length} application(s) listed`);

    let done = 0;
    for (const app of apps) {
      o.onProgress?.(done++, apps.length);
      if (o.db.isDone(app.source, app.id)) {
        sum.skipped++;
        continue;
      }
      const criteria = pickCriteria(o.criteria, app);
      if (!criteria) {
        log(`  - ${app.name} (${app.jobTitle ?? "?"}): no matching criteria file, skipped (add one or create criteria/default.yaml)`);
        sum.skipped++;
        continue;
      }
      try {
        let file: ResumeFile | null = null;
        let text = app.resumeText ?? (src.getResumeText ? await src.getResumeText(app) : "");
        if (!text) {
          file = await src.downloadResume(app);
          if (!file) throw new Error("no resume URL/text for this application");
          text = await resumeToText(file);
        }
        if (text.length < 50) throw new Error("resume text is empty (scanned image PDF?)");

        const r = await o.scorer.score(app, text, criteria);
        const reason = r.hardFilterFailures.length ? r.hardFilterFailures.join("; ") : `score ${r.score} < ${criteria.threshold}`;
        log(`  ${r.pass ? "✔" : "·"} ${app.name} [${criteria.name}] ${r.score}/100 ${r.pass ? "ACCEPTED" : `rejected (${reason})`}`);

        let notified = false;
        if (r.pass) {
          sum.accepted.push({ app, score: r.score });
          // attach the original file (e.g. uploaded PDF) when we scored from structured text
          if (!file && app.resumeUrl) file = await src.downloadResume(app).catch((e) => (log(`    (could not attach file: ${e.message})`), null));
          await o.notifier.sendAccepted(app, r, file);
          notified = true;
        } else {
          sum.rejected.push({ app, score: r.score, reason });
        }
        if (!o.dryRun)
          o.db.save({ ...rowFields(app, text), decision: r.pass ? "accepted" : "rejected", score: r.score, result: r, notified });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ✖ ${app.name}: ${msg}`);
        sum.errors.push({ app, source: src.name, error: msg });
        if (!o.dryRun) o.db.save({ ...rowFields(app), decision: "error", error: msg });
        if (e instanceof AuthError) break;
      }
    }
  }

  if (o.digest && (sum.rejected.length || sum.errors.length)) await o.notifier.sendText(formatDigest(sum)).catch((e) => log(`digest failed: ${e}`));
  log(`Done: ${sum.accepted.length} accepted, ${sum.rejected.length} rejected, ${sum.errors.length} errors, ${sum.skipped} skipped`);
  return sum;
}

function rowFields(app: Application, resumeText?: string) {
  return {
    source: app.source, id: app.id, name: app.name, job: app.jobTitle, jobId: app.jobId, resumeText,
    extra: app.extra, profileUrl: app.profileUrl, resumeUrl: app.resumeUrl, appliedAt: app.appliedAt,
  };
}

export function formatDigest(s: RunSummary): string {
  const e = escapeHtml;
  const lines = [`📋 <b>Run summary</b>: ${s.accepted.length} accepted, ${s.rejected.length} rejected, ${s.errors.length} errors`];
  if (s.rejected.length) {
    lines.push("\n<b>Rejected</b> (review if needed):");
    for (const r of s.rejected.slice(0, 40)) lines.push(`• ${e(r.app.name)} — ${e(r.app.jobTitle ?? "-")} — ${r.score ?? "-"} — ${e(r.reason)}`);
    if (s.rejected.length > 40) lines.push(`… and ${s.rejected.length - 40} more`);
  }
  if (s.errors.length) {
    lines.push("\n<b>Errors</b>:");
    for (const x of s.errors.slice(0, 20)) lines.push(`• ${e(x.app?.name ?? x.source)}: ${e(x.error.slice(0, 200))}`);
  }
  return lines.join("\n");
}
