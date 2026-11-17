import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  phone: string | null;
  site_status: string | null;
  site_status_at: string | null;
  gsheet_synced_at: string | null;
  attempts: number;
  notified: number;
  processed_at: string;
}

export interface ThreadRow {
  id: string;
  source: string;
  job_id: string;
  title: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
}

export interface JobStats {
  job_id: string;
  total: number;
  accepted: number;
  partial: number;
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
  phone: "TEXT",
  site_status: "TEXT", // status we set on the job site, e.g. "rejected"
  site_status_at: "TEXT",
  gsheet_synced_at: "TEXT",
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs_meta (
      source TEXT NOT NULL, job_id TEXT NOT NULL, unit TEXT, PRIMARY KEY (source, job_id))`);
    const metaCols = new Set((this.db.prepare("PRAGMA table_info(jobs_meta)").all() as any[]).map((c) => c.name));
    for (const col of ["title", "description", "ad_text", "ad_fetched_at"]) if (!metaCols.has(col)) this.db.exec(`ALTER TABLE jobs_meta ADD COLUMN ${col} TEXT`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, job_id TEXT NOT NULL, title TEXT NOT NULL,
      messages_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS chat_threads_job ON chat_threads (source, job_id, updated_at)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS chats (
      source TEXT NOT NULL, job_id TEXT NOT NULL, messages_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (source, job_id))`);
  }

  /** Store an applicant seen in the job list without scoring it. Never overwrites a scored row. */
  upsertListed(a: { source: string; id: string; name: string; job?: string; jobId?: string; extra?: unknown; profileUrl?: string; resumeUrl?: string; appliedAt?: string; phone?: string }) {
    this.db
      .prepare(
        `INSERT INTO applications (source,id,name,job,job_id,decision,attempts,processed_at,extra_json,profile_url,resume_url,applied_at,phone)
         VALUES (?,?,?,?,?,'pending',0,?,?,?,?,?,?)
         ON CONFLICT(source,id) DO UPDATE SET name=excluded.name, job=excluded.job, job_id=excluded.job_id,
           extra_json=excluded.extra_json, profile_url=excluded.profile_url, resume_url=COALESCE(excluded.resume_url, resume_url),
           applied_at=excluded.applied_at, phone=COALESCE(excluded.phone, phone)`,
      )
      .run(a.source, a.id, a.name, a.job ?? null, a.jobId ?? null, new Date().toISOString(), a.extra ? JSON.stringify(a.extra) : null, a.profileUrl ?? null, a.resumeUrl ?? null, a.appliedAt ?? null, a.phone ?? null);
  }

  getKv<T>(key: string): { value: T; updatedAt: string } | null {
    const r = this.db.prepare("SELECT json, updated_at FROM kv WHERE key=?").get(key) as { json: string; updated_at: string } | undefined;
    return r ? { value: JSON.parse(r.json) as T, updatedAt: r.updated_at } : null;
  }
  setKv(key: string, value: unknown) {
    this.db.prepare("INSERT INTO kv (key,json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(key, JSON.stringify(value), new Date().toISOString());
  }

  getJobMeta(source: string, jobId: string): { unit: string; title: string; description: string; adText: string; adFetchedAt: string | null } {
    const r = this.db.prepare("SELECT * FROM jobs_meta WHERE source=? AND job_id=?").get(source, jobId) as any;
    return { unit: r?.unit ?? "", title: r?.title ?? "", description: r?.description ?? "", adText: r?.ad_text ?? "", adFetchedAt: r?.ad_fetched_at ?? null };
  }
  /** Update some job meta fields (unit, title, description, ad_text, ad_fetched_at). */
  setJobMeta(source: string, jobId: string, fields: Partial<Record<"unit" | "title" | "description" | "ad_text" | "ad_fetched_at", string>>) {
    this.db.prepare("INSERT INTO jobs_meta (source,job_id) VALUES (?,?) ON CONFLICT(source,job_id) DO NOTHING").run(source, jobId);
    for (const [k, v] of Object.entries(fields)) this.db.prepare(`UPDATE jobs_meta SET ${k}=? WHERE source=? AND job_id=?`).run(v ?? "", source, jobId);
  }

  markSheetSynced(source: string, ids: string[]) {
    const at = new Date().toISOString();
    const st = this.db.prepare("UPDATE applications SET gsheet_synced_at=? WHERE source=? AND id=?");
    for (const id of ids) st.run(at, source, id);
  }

  setSiteStatus(source: string, ids: string[], status: string) {
    const at = new Date().toISOString();
    const st = this.db.prepare("UPDATE applications SET site_status=?, site_status_at=? WHERE source=? AND id=?");
    for (const id of ids) st.run(status, at, source, id);
  }

  getUnit(source: string, jobId: string): string {
    const r = this.db.prepare("SELECT unit FROM jobs_meta WHERE source=? AND job_id=?").get(source, jobId) as { unit: string | null } | undefined;
    return r?.unit ?? "";
  }
  setUnit(source: string, jobId: string, unit: string) {
    this.db.prepare("INSERT INTO jobs_meta (source,job_id,unit) VALUES (?,?,?) ON CONFLICT(source,job_id) DO UPDATE SET unit=excluded.unit").run(source, jobId, unit);
  }

  /** Rows for reports: optionally one job, decisions and/or ids. */
  report(source: string, f: { jobId?: string; decisions?: string[]; ids?: string[] }): (Row & { unit: string | null })[] {
    const where = ["a.source=?"];
    const args: string[] = [source];
    if (f.jobId) { where.push("a.job_id=?"); args.push(f.jobId); }
    if (f.decisions?.length) { where.push(`a.decision IN (${f.decisions.map(() => "?").join(",")})`); args.push(...f.decisions); }
    if (f.ids?.length) { where.push(`a.id IN (${f.ids.map(() => "?").join(",")})`); args.push(...f.ids); }
    return this.db
      .prepare(`SELECT a.*, m.unit FROM applications a LEFT JOIN jobs_meta m ON m.source=a.source AND m.job_id=a.job_id
                WHERE ${where.join(" AND ")} ORDER BY a.job, a.score DESC, a.applied_at DESC`)
      .all(...args) as unknown as (Row & { unit: string | null })[];
  }

  // ---- chat threads (several conversations per job)
  listThreads(source: string, jobId: string): ThreadRow[] {
    this.migrateLegacyChat(source, jobId);
    return this.db.prepare("SELECT * FROM chat_threads WHERE source=? AND job_id=? ORDER BY updated_at DESC").all(source, jobId) as unknown as ThreadRow[];
  }
  getThread(id: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM chat_threads WHERE id=?").get(id) as ThreadRow | undefined;
  }
  createThread(source: string, jobId: string, title: string, messages: unknown[] = []): ThreadRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO chat_threads (id,source,job_id,title,messages_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, source, jobId, title, JSON.stringify(messages), now, now);
    return this.getThread(id)!;
  }
  saveThread(id: string, fields: { title?: string; messages?: unknown[] }) {
    if (fields.title !== undefined) this.db.prepare("UPDATE chat_threads SET title=? WHERE id=?").run(fields.title, id);
    if (fields.messages !== undefined) this.db.prepare("UPDATE chat_threads SET messages_json=?, updated_at=? WHERE id=?").run(JSON.stringify(fields.messages), new Date().toISOString(), id);
  }
  deleteThread(id: string) {
    this.db.prepare("DELETE FROM chat_threads WHERE id=?").run(id);
  }
  /** the old single chat per job becomes the first thread */
  private migrateLegacyChat(source: string, jobId: string) {
    const old = this.getChat(source, jobId);
    if (!old.length) return;
    this.createThread(source, jobId, "گفتگوی قبلی", old);
    this.db.prepare("DELETE FROM chats WHERE source=? AND job_id=?").run(source, jobId);
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
    result?: unknown; notified?: boolean; resumeText?: string; extra?: unknown; profileUrl?: string; resumeUrl?: string; appliedAt?: string; phone?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO applications (source,id,name,job,job_id,decision,score,error,result_json,notified,processed_at,resume_text,extra_json,profile_url,resume_url,applied_at,phone)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source,id) DO UPDATE SET name=excluded.name, job=excluded.job, job_id=COALESCE(excluded.job_id, job_id),
           decision=excluded.decision, score=excluded.score, error=excluded.error, result_json=excluded.result_json,
           notified=excluded.notified, processed_at=excluded.processed_at, attempts=attempts+1,
           resume_text=COALESCE(excluded.resume_text, resume_text), extra_json=COALESCE(excluded.extra_json, extra_json),
           profile_url=COALESCE(excluded.profile_url, profile_url), resume_url=COALESCE(excluded.resume_url, resume_url),
           applied_at=COALESCE(excluded.applied_at, applied_at), phone=COALESCE(excluded.phone, phone)`,
      )
      .run(
        r.source, r.id, r.name, r.job ?? null, r.jobId ?? null, r.decision, r.score ?? null, r.error ?? null,
        r.result ? JSON.stringify(r.result) : null, r.notified ? 1 : 0, new Date().toISOString(),
        r.resumeText ?? null, r.extra ? JSON.stringify(r.extra) : null, r.profileUrl ?? null, r.resumeUrl ?? null, r.appliedAt ?? null, r.phone ?? null,
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
    return this.db.prepare("SELECT * FROM applications WHERE source=? AND job_id=? ORDER BY CASE decision WHEN 'accepted' THEN 0 WHEN 'partial' THEN 1 WHEN 'rejected' THEN 2 WHEN 'error' THEN 3 ELSE 4 END, score DESC, applied_at DESC").all(source, jobId) as unknown as Row[];
  }

  jobStats(source: string): JobStats[] {
    return this.db
      .prepare(
        `SELECT job_id, COUNT(*) total,
           SUM(decision='accepted') accepted, SUM(decision='partial') partial, SUM(decision='rejected') rejected, SUM(decision='error') errors, SUM(decision='pending') pending,
           ROUND(AVG(CASE WHEN decision IN ('accepted','partial','rejected') THEN score END),1) avg_score, MAX(CASE WHEN decision!='pending' THEN processed_at END) last_processed
         FROM applications WHERE source=? AND job_id IS NOT NULL GROUP BY job_id`,
      )
      .all(source) as unknown as JobStats[];
  }
}
