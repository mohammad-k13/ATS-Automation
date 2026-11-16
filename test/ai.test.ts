import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { LlmScorer, openAICompatComplete } from "../src/score";

test("OpenAI-compatible (OmniRoute) scorer: sends key/model, parses JSON reply, applies threshold", async () => {
  let seen: any = {};
  const srv = http.createServer(async (q, r) => {
    let b = ""; for await (const c of q) b += c;
    seen = { url: q.url, auth: q.headers.authorization, body: JSON.parse(b) };
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ choices: [{ message: { content: 'Sure:\n```json\n{"score": 82, "yearsExperience": 4, "matched": ["Node.js"], "missing": [], "redFlags": [], "summary": "Good fit"}\n```' } }] }));
  });
  await new Promise<void>((res) => srv.listen(8833, res));
  try {
    const s = new LlmScorer(openAICompatComplete("http://127.0.0.1:8833", "k123", "my/model"));
    const r = await s.score({ source: "t", id: "1", name: "A" }, "resume text", { name: "x", match: {}, threshold: 70, partialThreshold: 50, mustHave: ["Node.js"], niceToHave: [], hardFilters: { minYears: 5 } });
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.auth, "Bearer k123");
    assert.equal(seen.body.model, "my/model");
    assert.equal(r.score, 82);
    assert.equal(r.pass, false, "minYears 5 > 4 must fail even with score 82");
    assert.deepEqual(r.hardFilterFailures, ["experience 4y < 5y"]);
  } finally {
    srv.close();
  }
});
