import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision } from "./types";

export interface Row {
  source: string;
  id: string;
  name: string;
  job: string | null;
  job_id: string | null;
  decision: Decision;
  score: number | null;
  error: string | null;
  result_json: string | null;
  resume_text: string | null;
  extra_json: string | null;
  profile_url: string | null;
  resume_url: string | null;
  applied_at: string | null;
  attempts: number;
  notified: number;
  processed_at: string;
}

export interface JobStats {
  job_id: string;
  total: number;
  accepted: number;
  rejected: number;
  errors: number;
  pending: number;
  avg_score: number | null;
  last_processed: string | null;
}

const EXTRA_COLUMNS: Record<string, string> = {
  job_id: "TEXT",
  resume_text: "TEXT",
  extra_json: "TEXT",
  profile_url: "TEXT",
  resume_url: "TEXT",
  applied_at: "TEXT",
};

export class Db {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS applications (
      source TEXT NOT NULL, id TEXT NOT NULL, name TEXT, job TEXT,
      decision TEXT NOT NULL, score REAL, error TEXT, result_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 1, notified INTEGER NOT NULL DEFAULT 0,
      processed_at TEXT NOT NULL, PRIMARY KEY (source, id))`);
    // migrate older databases
    const have = new Set((this.db.prepare("PRAGMA table_info(applications)").all() as any[]).map((c) => c.name));
    for (const [col, type] of Object.entries(EXTRA_COLUMNS)) if (!have.has(col)) this.db.exec(`ALTER TABLE applications ADD COLUMN ${col} ${type}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chats (
      source TEXT NOT NULL, job_id TEXT NOT NULL, messages_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (source, job_id))`);
  }

  /** Store an applicant seen in the job list without scoring it. Never overwrites a scored row. */
  upsertListed(a: { source: string; id: string; name: string; job?: string; jobId?: string; extra?: unknown; profileUrl?: string; resumeUrl?: string; appliedAt?: string }) {
    this.db
      .prepare(
        `INSERT INTO applications (source,id,name,job,job_id,decision,attempts,processed_at,extra_json,profile_url,resume_url,applied_at)
         VALUES (?,?,?,?,?,'pending',0,?,?,?,?,?)
         ON CONFLICT(source,id) DO UPDATE SET name=excluded.name, job=excluded.job, job_id=excluded.job_id,
           extra_json=excluded.extra_json, profile_url=excluded.profile_url, resume_url=COALESCE(excluded.resume_url, resume_url),
           applied_at=excluded.applied_at`,
      )
      .run(a.source, a.id, a.name, a.job ?? null, a.jobId ?? null, new Date().toISOString(), a.extra ? JSON.stringify(a.extra) : null, a.profileUrl ?? null, a.resumeUrl ?? null, a.appliedAt ?? null);
  }

  getChat(source: string, jobId: string): { role: "user" | "assistant"; content: string }[] {
    const r = this.db.prepare("SELECT messages_json FROM chats WHERE source=? AND job_id=?").get(source, jobId) as { messages_json: string } | undefined;
    return r ? JSON.parse(r.messages_json) : [];
  }

  saveChat(source: string, jobId: string, messages: { role: "user" | "assistant"; content: string }[]) {
    this.db
      .prepare(
        `INSERT INTO chats (source,job_id,messages_json,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(source,job_id) DO UPDATE SET messages_json=excluded.messages_json, updated_at=excluded.updated_at`,
      )
      .run(source, jobId, JSON.stringify(messages), new Date().toISOString());
  }

  get(source: string, id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM applications WHERE source=? AND id=?").get(source, id) as Row | undefined;
  }

  /** Done = accepted/rejected, or errored too many times. */
  isDone(source: string, id: string, maxAttempts = 3): boolean {
    const r = this.get(source, id);
    return !!r && r.decision !== "pending" && (r.decision !== "error" || r.attempts >= maxAttempts);
  }

  save(r: {
    source: string; id: string; name: string; job?: string; jobId?: string; decision: Decision; score?: number; error?: string;
    result?: unknown; notified?: boolean; resumeText?: string; extra?: unknown; profileUrl?: string; resumeUrl?: string; appliedAt?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO applications (source,id,name,job,job_id,decision,score,error,result_json,notified,processed_at,resume_text,extra_json,profile_url,resume_url,applied_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source,id) DO UPDATE SET name=excluded.name, job=excluded.job, job_id=COALESCE(excluded.job_id, job_id),
           decision=excluded.decision, score=excluded.score, error=excluded.error, result_json=excluded.result_json,
           notified=excluded.notified, processed_at=excluded.processed_at, attempts=attempts+1,
           resume_text=COALESCE(excluded.resume_text, resume_text), extra_json=COALESCE(excluded.extra_json, extra_json),
           profile_url=COALESCE(excluded.profile_url, profile_url), resume_url=COALESCE(excluded.resume_url, resume_url),
           applied_at=COALESCE(excluded.applied_at, applied_at)`,
      )
      .run(
        r.source, r.id, r.name, r.job ?? null, r.jobId ?? null, r.decision, r.score ?? null, r.error ?? null,
        r.result ? JSON.stringify(r.result) : null, r.notified ? 1 : 0, new Date().toISOString(),
        r.resumeText ?? null, r.extra ? JSON.stringify(r.extra) : null, r.profileUrl ?? null, r.resumeUrl ?? null, r.appliedAt ?? null,
      );
  }

  forget(source: string, id?: string) {
    if (id) this.db.prepare("DELETE FROM applications WHERE source=? AND id=?").run(source, id);
    else this.db.prepare("DELETE FROM applications WHERE source=?").run(source);
  }

  forgetJob(source: string, jobId: string) {
    this.db.prepare("DELETE FROM applications WHERE source=? AND job_id=?").run(source, jobId);
  }

  list(limit = 50): Row[] {
    return this.db.prepare("SELECT * FROM applications ORDER BY processed_at DESC LIMIT ?").all(limit) as unknown as Row[];
  }

  listByJob(source: string, jobId: string): Row[] {
    return this.db.prepare("SELECT * FROM applications WHERE source=? AND job_id=? ORDER BY CASE decision WHEN 'accepted' THEN 0 WHEN 'rejected' THEN 1 WHEN 'error' THEN 2 ELSE 3 END, score DESC, applied_at DESC").all(source, jobId) as unknown as Row[];
  }

  jobStats(source: string): JobStats[] {
    return this.db
      .prepare(
        `SELECT job_id, COUNT(*) total,
           SUM(decision='accepted') accepted, SUM(decision='rejected') rejected, SUM(decision='error') errors, SUM(decision='pending') pending,
           ROUND(AVG(CASE WHEN decision IN ('accepted','rejected') THEN score END),1) avg_score, MAX(CASE WHEN decision!='pending' THEN processed_at END) last_processed
         FROM applications WHERE source=? AND job_id IS NOT NULL GROUP BY job_id`,
      )
      .all(source) as unknown as JobStats[];
  }
}
