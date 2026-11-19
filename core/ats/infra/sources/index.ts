import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { Source } from '../../domain/types';
import { interpolate } from '../../../shared/util';
import { FolderSource, FolderSourceConfig } from './folder-source';
import { HttpSource, HttpSourceConfig } from './http-source';
import { JobvisionSource, JobvisionSourceConfig } from './jobvision-source';

export const SourcesFile = z.object({
  sources: z.array(
    z.discriminatedUnion('type', [HttpSourceConfig, FolderSourceConfig, JobvisionSourceConfig]),
  ),
});

/** Validate sources.yaml text; returns error message or null. */
export function validateSourcesYaml(text: string): string | null {
  try {
    const parsed = SourcesFile.safeParse(interpolate(YAML.parse(text)));
    return parsed.success
      ? null
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function loadSources(file: string, only?: string): Source[] {
  if (!fs.existsSync(file))
    throw new Error(
      `${file} not found. Copy sources.example.yaml to ${file} and fill in your endpoint.`,
    );
  const parsed = SourcesFile.safeParse(interpolate(YAML.parse(fs.readFileSync(file, 'utf8'))));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data.sources
    .filter((s) => (only ? s.name === only : s.enabled))
    .map((s) => {
      const proxy =
        s.type !== 'folder' ? s.proxy || process.env.SOURCE_PROXY || undefined : undefined;
      if (s.type === 'http') return new HttpSource({ ...s, proxy });
      if (s.type === 'jobvision') return new JobvisionSource({ ...s, proxy });
      return new FolderSource(s);
    });
}
