import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision } from "./types.js";

export interface Row {
  source: string;
  id: string;
  name: string;
  job: string | null;
  decision: Decision;
  score: number | null;
  error: string | null;
  attempts: number;
  notified: number;
  processed_at: string;
}

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
  }

  get(source: string, id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM applications WHERE source=? AND id=?").get(source, id) as Row | undefined;
  }

  /** Done = accepted/rejected, or errored too many times. */
  isDone(source: string, id: string, maxAttempts = 3): boolean {
    const r = this.get(source, id);
    return !!r && (r.decision !== "error" || r.attempts >= maxAttempts);
  }

  save(r: { source: string; id: string; name: string; job?: string; decision: Decision; score?: number; error?: string; result?: unknown; notified?: boolean }) {
    this.db
      .prepare(
        `INSERT INTO applications (source,id,name,job,decision,score,error,result_json,notified,processed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source,id) DO UPDATE SET name=excluded.name, job=excluded.job, decision=excluded.decision,
           score=excluded.score, error=excluded.error, result_json=excluded.result_json,
           notified=excluded.notified, processed_at=excluded.processed_at, attempts=attempts+1`,
      )
      .run(r.source, r.id, r.name, r.job ?? null, r.decision, r.score ?? null, r.error ?? null, r.result ? JSON.stringify(r.result) : null, r.notified ? 1 : 0, new Date().toISOString());
  }

  forget(source: string, id?: string) {
    if (id) this.db.prepare("DELETE FROM applications WHERE source=? AND id=?").run(source, id);
    else this.db.prepare("DELETE FROM applications WHERE source=?").run(source);
  }

  list(limit = 50): Row[] {
    return this.db.prepare("SELECT * FROM applications ORDER BY processed_at DESC LIMIT ?").all(limit) as unknown as Row[];
  }
}
