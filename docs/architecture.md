# Architecture in one page

```
Jobvision employer API ──► core/ats/infra/sources/jobvision-source.ts ─┐
OmniRoute / Anthropic  ──► core/ats/infra/ai.ts, domain/score.ts ──────┤
Telegram               ──► core/ats/infra/telegram.ts ──────────────────┼─► core/ats/application/* ──► app/api/[...path]/route.ts ──► dashboard (app/)
Google Sheet           ──► core/ats/infra/gsheet.ts ────────────────────┤            │
SQLite + settings.json ──► core/ats/infra/db.ts, platform/settings-store ┘            └─► core/cli.ts (headless)
```

**Layers (dependencies point down only):** `domain` (pure rules, no I/O) ← `infra` (talks to the outside world) ← `application` (use-cases, one file per concern) ← `app/` and `core/cli.ts` (thin entry points). Nothing under `core/` may import React or Next.js. `core/ats/application/index.ts` is the one barrel everything imports from.

## Where things are

| Area                                                                     | Files                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Pulling applicants, resumes, status changes                              | `core/ats/infra/sources/jobvision-source.ts` (+ `index.ts`, `http-source.ts`, `folder-source.ts`)                        |
| Login to Jobvision (auto, manual with captcha, token renewal, diagnosis) | `core/ats/infra/auth/` (`jobvision-login.ts`, `remote-login.ts`, `token.ts`, `jobvision-diagnose.ts`)                    |
| Dashboard login and sessions                                             | `core/platform/auth/session.ts`                                                                                          |
| Scoring, criteria, hard filters, keywords                                | `core/ats/domain/` (`score.ts`, `criteria.ts`, `keywords.ts`), AI client `core/ats/infra/ai.ts`                          |
| Work-history alerts (gaps, overlaps, job hopping)                        | `core/ats/domain/experience.ts`                                                                                          |
| Reports, Excel/CSV, "tell it what you want" exports                      | `core/ats/infra/exports.ts`, `xlsx.ts`, `core/platform/tasks.ts`, `application/data-tasks.ts`, `application/report.ts`   |
| Google Sheet sync                                                        | `core/ats/infra/gsheet.ts`, `application/sheet-sync.ts`                                                                  |
| Reject / status mapping on the job site                                  | `application/site-status.ts`                                                                                             |
| Resume files and ZIP downloads                                           | `application/files.ts`                                                                                                   |
| Chat assistant                                                           | `application/chat.ts`                                                                                                    |
| Storage                                                                  | `core/ats/infra/db.ts` (SQLite via `node:sqlite`), `core/platform/settings-store.ts` (`settings.json`, overrides `.env`) |
| Fetch → score → notify, schedule                                         | `application/pipeline.ts`, `core/cli.ts`                                                                                 |
| API                                                                      | `app/api/[...path]/route.ts` (one route table)                                                                           |
| Pages and components                                                     | `app/`, shared UI in `app/components/`, data fetching in `app/lib/`                                                      |
| Server install and updates                                               | `deploy/linux/install.sh`, `deploy/linux/ats`                                                                            |

## Principles that are easy to break

- **The AI plans, the server fills.** For exports and rules the AI returns a plan; cells come from the database. Phone numbers are never in a prompt.
- **Writes to Jobvision are explicit.** Reading never marks candidates as seen.
- **Secrets live only in `settings.json`** next to the database (0600), not in git and not in `.env` (which mangles `$` and `#`).
- **Updates must not lose data.** Data lives in `/var/lib/ats`; releases are disposable.
- **Everything has a mock in tests.** Jobvision blocks non-Iranian IPs, so CI and cloud sessions never reach it; behaviour against the real site is checked by a person on the server.

## Data

SQLite tables: `applications` (one row per applicant, with extra JSON), `jobs_meta`, `kv` (saved tasks, Google Sheet config), `chat_threads`. Migrations are additive and run on start (`core/ats/infra/db.ts`).
