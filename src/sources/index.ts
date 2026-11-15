import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { Source } from "../types.js";
import { interpolate } from "../util.js";
import { FolderSource, FolderSourceConfig } from "./folder-source.js";
import { HttpSource, HttpSourceConfig } from "./http-source.js";

const SourcesFile = z.object({ sources: z.array(z.discriminatedUnion("type", [HttpSourceConfig, FolderSourceConfig])) });

export function loadSources(file: string, only?: string): Source[] {
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Copy sources.example.yaml to ${file} and fill in your endpoint.`);
  const parsed = SourcesFile.safeParse(interpolate(YAML.parse(fs.readFileSync(file, "utf8"))));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data.sources
    .filter((s) => (only ? s.name === only : s.enabled))
    .map((s) => {
      if (s.type === "http") return new HttpSource({ ...s, proxy: s.proxy || process.env.SOURCE_PROXY || undefined });
      return new FolderSource(s);
    });
}
