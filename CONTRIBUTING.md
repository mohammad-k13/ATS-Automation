# Working on this project as a team

Read this once. It is short on purpose.

## The one rule that shapes everything

**`main` is production.** Servers pull `main` every 30 minutes and update themselves. So nobody pushes to `main` directly: everything goes through a pull request that passes CI (types, tests, build).

## Daily flow

1. **Pick a task** in ClickUp (see [docs/team-workflow.md](docs/team-workflow.md)) and move it to _In progress_.
2. **Branch from `main`**: `git switch -c <type>/<short-name>` — types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Example: `fix/attachment-401`.
3. **Commit small**, with a message that says why: `fix: download attached resume with the sign-in cookie`.
4. **Check locally**: `npm run check` (types + tests). For UI changes also run `npm run dev` and look at the page in light and dark mode.
5. **Open a pull request** (the template asks the right questions). Put the ClickUp link in it. Move the task to _In review_.
6. **One review**, then **Squash and merge**. Delete the branch. Task → _Done_ once it is live on the server (`ats version` shows the new commit).

Keep PRs small (a day of work or less). A big change is several PRs behind a setting, not one huge one.

## Setup

Node 22.13+.

```bash
git clone https://github.com/mohammad-k13/ATS-Automation.git
cd ATS-Automation
npm install
cp .env.example .env
npm run dev
```

Everything else (token, AI, Telegram) is configured in the dashboard under Settings; see the README.

## Commands

| Command                    | What it does                                 |
| -------------------------- | -------------------------------------------- |
| `npm run dev`              | Dashboard with hot reload                    |
| `npm run check`            | Types + tests (run before every PR)          |
| `npm run format`           | Prettier (CI runs `format:check`)            |
| `npm test`                 | Tests only (`node:test`, no extra framework) |
| `npm run typecheck`        | `tsc --noEmit`                               |
| `npm run build`            | Production build (CI runs it too)            |
| `npm run ats -- <command>` | CLI: `login`, `probe`, `diagnose`, `run`, …  |

## Code conventions

- TypeScript, extensionless imports. Formatting is Prettier (`npm run format`); don't hand-format.
- **UI is Persian and RTL**; test light and dark. Keep the green palette.
- Logic lives in `core/` (no React or Next.js imports there); `app/` only shows things. Layers: `domain` ← `infra` ← `application` (see [docs/architecture.md](docs/architecture.md)). The API route table is `app/api/[...path]/route.ts`.
- Files that a browser component imports must not pull in server-only code (see `core/ats/domain/keywords.ts` for the pattern).
- Every bug fix and new rule gets a test. Tests live in `test/` and use mock servers; they never call Jobvision, Google or an AI for real.
- Prefer a small change to an existing module over a rewrite.

## Never commit or paste anywhere (issues, PRs, chat, screenshots)

- Tokens, cookies, passwords, API keys, `.env`, `settings.json`, HAR files, full cURL commands. Replace values with `XXX`; header and cookie **names** are fine.
- Real candidate data: names, phone numbers, resumes. Use `test/samples/` or invent data.
- Phone numbers must never be sent to the AI. Anything that **writes to Jobvision** (changing status, reject) must stay behind an explicit confirmation.

If a secret was committed, rotate it first, then tell the owner. Removing it from a later commit is not enough.

## Releasing and rolling back

Merging to `main` is releasing. The server builds the new version next to the old one, health-checks it, and rolls back by itself if it does not start. To go back manually: `sudo ats rollback`; then revert the PR on GitHub so `main` matches.

## Who decides

The owner ([@mohammad-k13](https://github.com/mohammad-k13)) is the default reviewer (`.github/CODEOWNERS`). Changes to `deploy/`, `core/ats/infra/auth/` and `.github/` always need the owner's review because they affect every server and hold the login logic.
