import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { httpFetch } from "./http.js";
import type { Application, Criteria, ScoreResult } from "./types.js";

export interface Scorer {
  score(app: Application, resumeText: string, c: Criteria): Promise<ScoreResult>;
}

/** Normalize Arabic/Persian variants and case so keyword matching works on Persian resumes too. */
export function normalize(s: string): string {
  return s
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‏]/g, " ")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .toLowerCase();
}

export function hasKeyword(text: string, kw: string): boolean {
  const t = normalize(text);
  const k = normalize(kw).trim();
  if (!k) return false;
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(t);
}

export function keywordScore(text: string, c: Criteria) {
  const matched = [...c.mustHave, ...c.niceToHave].filter((k) => hasKeyword(text, k));
  const missing = c.mustHave.filter((k) => !hasKeyword(text, k));
  const total = c.mustHave.length * 3 + c.niceToHave.length;
  const got = c.mustHave.filter((k) => hasKeyword(text, k)).length * 3 + c.niceToHave.filter((k) => hasKeyword(text, k)).length;
  return { score: total ? Math.round((100 * got) / total) : 0, matched, missing };
}

/** Deterministic rules applied before/after the LLM. Returns list of failure reasons. */
export function hardFilterFailures(text: string, c: Criteria, years?: number | null): string[] {
  const f = c.hardFilters;
  const out: string[] = [];
  if (f.requireAny?.length && !f.requireAny.some((k) => hasKeyword(text, k))) out.push(`none of required: ${f.requireAny.join(", ")}`);
  for (const k of f.rejectIfAny ?? []) if (hasKeyword(text, k)) out.push(`contains rejected term: ${k}`);
  if (f.minYears != null && years != null && years < f.minYears) out.push(`experience ${years}y < ${f.minYears}y`);
  return out;
}

export class KeywordScorer implements Scorer {
  async score(_app: Application, text: string, c: Criteria): Promise<ScoreResult> {
    const k = keywordScore(text, c);
    const hard = hardFilterFailures(text, c, null);
    return {
      ...k,
      pass: hard.length === 0 && k.score >= c.threshold,
      redFlags: [],
      summary: `Keyword match ${k.matched.length}/${c.mustHave.length + c.niceToHave.length}`,
      yearsExperience: null,
      hardFilterFailures: hard,
      method: "keyword",
    };
  }
}

const LlmResult = z.object({
  candidateName: z.string().nullable().optional(),
  yearsExperience: z.number().nullable().optional(),
  score: z.number().min(0).max(100),
  matched: z.array(z.string()).default([]),
  missing: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
  summary: z.string(),
});

const SYSTEM = `You are a strict, fair technical recruiter screening resumes for a company in Iran.
Resumes may be in Persian or English. Judge only on evidence in the resume; do not reward keyword stuffing.
Do not consider gender, age, religion, ethnicity, marital status or photo — only skills, experience and the employer's job-related instructions.
Reply with ONE JSON object only, no prose, matching:
{"candidateName": string|null, "yearsExperience": number|null (total relevant professional years),
 "score": 0-100 (fit for this job), "matched": [requirements clearly evidenced], "missing": [must-haves NOT evidenced],
 "redFlags": [concrete concerns, e.g. unexplained gaps, job hopping, mismatch with instructions],
 "summary": "2-3 sentence English summary of the candidate and fit"}
Scoring guide: 85+ strong hire-interview, 70-84 good, 50-69 partial, <50 poor. Missing any must-have usually caps the score at 65.`;

/** Something that turns (system, user) into model text. */
export type Complete = (system: string, user: string) => Promise<string>;

export function anthropicComplete(apiKey: string, model: string): Complete {
  const client = new Anthropic({ apiKey });
  return async (system, user) => {
    const msg = await client.messages.create({ model, max_tokens: 1500, system, messages: [{ role: "user", content: user }] });
    return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  };
}

/** Any OpenAI-compatible endpoint: OmniRoute, OpenRouter, LiteLLM, a local server... */
export function openAICompatComplete(baseUrl: string, apiKey: string, model: string): Complete {
  let base = baseUrl.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(base)) base += "/v1";
  return async (system, user) => {
    const res = await httpFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 1500, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    }, undefined, 120_000);
    const body = await res.text();
    if (!res.ok) throw new Error(`AI router HTTP ${res.status} at ${base}/chat/completions: ${body.slice(0, 300)}`);
    const json = JSON.parse(body);
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`AI router returned no message content: ${body.slice(0, 300)}`);
    return content;
  };
}

export class LlmScorer implements Scorer {
  constructor(private complete: Complete) {}

  async score(app: Application, text: string, c: Criteria): Promise<ScoreResult> {
    const user = [
      `JOB: ${app.jobTitle ?? c.name}`,
      `MUST HAVE: ${c.mustHave.join(", ") || "-"}`,
      `NICE TO HAVE: ${c.niceToHave.join(", ") || "-"}`,
      c.hardFilters.minYears != null ? `MIN YEARS: ${c.hardFilters.minYears}` : "",
      c.instructions ? `EMPLOYER INSTRUCTIONS:\n${c.instructions}` : "",
      app.extra && Object.keys(app.extra).length ? `APPLICATION DATA: ${JSON.stringify(app.extra)}` : "",
      `\nRESUME:\n${text.slice(0, 30000)}`,
    ]
      .filter(Boolean)
      .join("\n");

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.complete(SYSTEM, user);
      const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      try {
        const r = LlmResult.parse(JSON.parse(json));
        const hard = hardFilterFailures(text, c, r.yearsExperience);
        return {
          score: Math.round(r.score),
          pass: hard.length === 0 && r.score >= c.threshold,
          matched: r.matched,
          missing: r.missing,
          redFlags: r.redFlags,
          summary: r.summary,
          yearsExperience: r.yearsExperience ?? null,
          hardFilterFailures: hard,
          method: "llm",
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`AI returned invalid JSON: ${String(lastErr)}`);
  }
}
