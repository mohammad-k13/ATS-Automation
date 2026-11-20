# Architecture in one page

```
Jobvision employer API ──► sources/jobvision-source.ts ─┐
                                                        ├─► service.ts ──► app/api/[...path]/route.ts ──► dashboard (app/)
OmniRoute / Anthropic  ──► ai.ts, score.ts ─────────────┤        │
Telegram               ──► telegram.ts ─────────────────┤        └─► SQLite (db.ts) + settings.json
Google Sheet (Apps Script) ► gsheet.ts ─────────────────┘
```

**Rule of thumb:** `src/service.ts` is the brain; the API route and the CLI are thin wrappers around it; React components only call the API.

## Where things are
| Area | Files |
| --- | --- |
| Pulling applicants, resumes, status changes | `src/sources/jobvision-source.ts`, `src/sources/index.ts` |
| Login to Jobvision (auto, manual with captcha, token renewal) | `src/auth/jobvision-login.ts`, `remote-login.ts`, `token.ts`, `jobvision-diagnose.ts` |
| Dashboard login and sessions | `src/auth/session.ts` |
| Scoring and criteria (hard filters, thresholds, AI prompt) | `src/score.ts`, `src/criteria.ts`, `src/keywords.ts`, `src/ai.ts` |
| Work-history alerts (gaps, overlaps, job hopping) | `src/experience.ts` |
| Reports, Excel/CSV, "tell it what you want" exports | `src/exports.ts`, `src/xlsx.ts`, `src/tasks.ts` |
| Google Sheet sync | `src/gsheet.ts` (+ sync logic in `service.ts`) |
| Storage | `src/db.ts` (SQLite via `node:sqlite`), `src/settings-store.ts` (`settings.json`, overrides `.env`) |
| Background scoring, schedule | `src/pipeline.ts`, `src/cli.ts` (`schedule`) |
| Pages | `app/` (Next.js App Router), shared UI in `app/components/`, data fetching in `app/lib/` |
| Server install and updates | `deploy/linux/install.sh`, `deploy/linux/ats` |

## Principles that are easy to break
- **The AI plans, the server fills.** For exports and rules the AI returns a plan; cells come from the database. Phone numbers are never in a prompt.
- **Writes to Jobvision are explicit.** Reading never marks candidates as seen.
- **Secrets live only in `settings.json`** next to the database (0600), not in git and not in `.env` (which mangles `$` and `#`).
- **Updates must not lose data.** Data lives in `/var/lib/ats`; releases are disposable.
- **Everything has a mock in tests.** Jobvision blocks non-Iranian IPs, so CI and cloud sessions never reach it; behaviour against the real site is checked by a person on the server.

## Data
SQLite tables: `applications` (one row per applicant, with extra JSON), `jobs_meta`, `kv` (saved tasks, Google Sheet config), `chat_threads`. Migrations are additive and run on start (`db.ts`).
