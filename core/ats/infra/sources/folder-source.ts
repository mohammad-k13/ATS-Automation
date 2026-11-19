import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Application, ResumeFile, Source } from '../../domain/types';

/** Reads resumes from a local folder: <dir>/<job title>/<file>.pdf|docx|txt. Used for testing. */
export const FolderSourceConfig = z.object({
  name: z.string(),
  type: z.literal('folder'),
  enabled: z.boolean().default(true),
  dir: z.string(),
});
export type FolderSourceConfig = z.infer<typeof FolderSourceConfig>;

export class FolderSource implements Source {
  name: string;
  constructor(private cfg: FolderSourceConfig) {
    this.name = cfg.name;
  }
  async listApplications(): Promise<Application[]> {
    if (!fs.existsSync(this.cfg.dir)) return [];
    const out: Application[] = [];
    for (const job of fs
      .readdirSync(this.cfg.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())) {
      for (const f of fs
        .readdirSync(path.join(this.cfg.dir, job.name))
        .filter((f) => /\.(pdf|docx|txt)$/i.test(f))) {
        const file = path.join(this.cfg.dir, job.name, f);
        out.push({
          source: this.name,
          id: `${job.name}/${f}`,
          name: path.parse(f).name,
          jobTitle: job.name,
          resumeUrl: file,
        });
      }
    }
    return out;
  }
  async downloadResume(app: Application): Promise<ResumeFile | null> {
    if (!app.resumeUrl) return null;
    return {
      data: new Uint8Array(fs.readFileSync(app.resumeUrl)),
      filename: path.basename(app.resumeUrl),
    };
  }
}
