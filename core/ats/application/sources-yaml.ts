/** Reading/writing sources.yaml itself (the file editable from "منابع و توکن‌ها"). */
import fs from 'node:fs';
import YAML from 'yaml';
import { validateSourcesYaml } from '../infra/sources/index';
import { SOURCES_FILE, UserError } from './state';

export function readSourcesYaml() {
      const f = SOURCES_FILE();
      return {
            file: f,
            text: fs.existsSync(f)
                  ? fs.readFileSync(f, 'utf8')
                  : fs.readFileSync('sources.example.yaml', 'utf8'),
            exists: fs.existsSync(f),
      };
}
export function saveSourcesYaml(text: string) {
      const err = validateSourcesYaml(text);
      if (err) throw new UserError(`فایل معتبر نیست:\n${err}`);
      fs.writeFileSync(SOURCES_FILE(), text);
      return readSourcesYaml();
}

/** Raw (uninterpolated) config of one source from sources.yaml. */
export function rawSourceConfig(src: string): any {
      const doc = YAML.parse(readSourcesYaml().text);
      return (doc?.sources ?? []).find((s: any) => s.name === src) ?? {};
}

/** Is this job included in scheduled/CLI runs (jobPostIds)? Toggle it, keeping comments. */
export function setJobScheduled(src: string, jobId: string, on: boolean) {
      const doc = YAML.parseDocument(readSourcesYaml().text);
      const list = doc.get('sources') as YAML.YAMLSeq | undefined;
      const item = list?.items.find((i: any) => i.get?.('name') === src) as
            YAML.YAMLMap | undefined;
      if (!item) throw new UserError(`${src} در sources.yaml نیست`);
      const ids = ((item.toJSON() as any).jobPostIds ?? [])
            .map(Number)
            .filter((x: number) => x !== Number(jobId));
      if (on) ids.push(Number(jobId));
      item.set('jobPostIds', doc.createNode(ids, { flow: true }));
      saveSourcesYaml(doc.toString());
}
