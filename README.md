# ATS Automation

Custom ATS for your company: pulls applicants from your **Jobinja / Jobvision employer panel** (via the panel's own JSON endpoints), scores each resume against your per-job criteria (Claude API, Persian + English), and sends **only accepted candidates** (summary + resume file) to Telegram. Rejected candidates are listed in a digest so nothing is silently dropped. Runs on demand or on a schedule; SQLite makes sure nobody is processed or sent twice.

## Install on a Linux server (recommended for teams)
One command installs Node.js, OmniRoute and the dashboard, creates systemd services and a login:
```bash
curl -fsSL https://raw.githubusercontent.com/mohammad-k13/ATS-Automation/main/deploy/linux/install.sh | sudo bash
```
Then open `http://<server-ip>:3000`. Coworkers only need a browser.

- **Automatic updates** every 30 minutes (`ats-update.timer`). Each version is built next to the running one, switched only after a successful build, health-checked, and **rolled back automatically** if it does not start. Updates wait while resumes are being scored.
- **Your data** lives in `/var/lib/ats` (`.env`, `sources.yaml`, `criteria/`, `ats.db`) and is never touched by updates.
- Options: `ATS_PORT`, `ATS_ADMIN_USER`, `ATS_ADMIN_PASSWORD`, `ATS_AUTO_UPDATE=0`, `ATS_NPM_REGISTRY` (npm mirror), `ATS_NODE_MIRROR` — e.g. `curl ... | sudo ATS_PORT=8080 bash`.
- The server must be able to reach jobvision.ir (it blocks non-Iranian IPs) and GitHub; Telegram may need `TELEGRAM_PROXY`.

```bash
ats status              # versions, health, services
ats logs                # live logs (ats logs omniroute)
sudo ats update         # update now
sudo ats rollback       # previous version
sudo ats passwd admin   # change the dashboard password
sudo ats config         # edit .env
sudo ats update-omniroute
```

## Setup for development (Windows / Linux, Node 22.13+)
```bash
git clone https://github.com/mohammad-k13/ATS-Automation.git
cd ATS-Automation
npm install
copy .env.example .env          # Linux/macOS: cp
copy sources.example.yaml sources.yaml
```
1. **Endpoint** - in the employer panel open DevTools > Network > Fetch/XHR, open your applicants list, find the request that returns the applicants JSON. Put its URL in `sources.yaml` (`list.url`), and copy the `Cookie` and/or `Authorization` request header values into `.env` (`JOBINJA_COOKIE`, `JOBINJA_TOKEN`, ...). Set `enabled: true`.
2. **Map fields** - run `npm run probe -- jobinja`. It prints the raw JSON and the mapped result; adjust `itemsPath` and `fields` (dotted paths) until name/job/resume URL look right.
3. **Criteria** - one YAML per job in `criteria/` (see `backend-developer.example.yaml`): must-have, nice-to-have, hard filters, threshold, free-text instructions. `default.yaml` is used when no job-specific file matches.
4. **Telegram** - create a bot with @BotFather, add it to your private group/chat, put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`, then `npm run ats -- test-telegram`. If the machine is in Iran, set `TELEGRAM_PROXY` (e.g. your local v2ray HTTP proxy `http://127.0.0.1:10809`).
5. **AI** - OmniRoute: set `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL` and check with `npm run ats -- test-ai`. Or `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`. Without AI, keyword-only scoring is used.

## Jobvision (built in)
1. Log in to employer.jobvision.ir, open DevTools > Network, click any request to `employerapi.jobvision.ir`, copy the **Authorization** header value into `.env` as `JOBVISION_TOKEN`.
2. In `sources.yaml` set `jobPostIds` (the number in `employer.jobvision.ir/jobs/<ID>/applications`).
3. `npm run probe -- jobvision` shows the applicants and the resume text the scorer sees.
- Read-only: it never calls `ViewCvFor3Seconds` or changes statuses, so applicants are not marked as seen.
- Only applicants in status 10 (undecided) are pulled. The token expires after ~6 hours (you get a 🔐 alert).
- **Jobvision blocks non-Iranian IPs** - run it from a machine in Iran (your PC or an Iranian VPS) and use `TELEGRAM_PROXY` for Telegram.

## Dashboard (Next.js, Persian UI)
```bash
npm run dev
```
Open http://localhost:3000.
- **Platforms** in the sidebar → active job posts with accepted/rejected %.
- **Job page** → resumes tab (score all new / selected / one, re-score, filters, resume details with strong/weak points) and settings tab (describe the job in plain words → AI drafts the criteria → edit → save; auto-run toggle). The **hiring assistant chat** on the side answers questions about the job and its resumes.
- **منابع و توکن‌ها** → edit `sources.yaml`, update platform tokens.

For daily use: `npm run build` once, then `npm start` (faster than dev mode).

## Automatic login (no DevTools needed)
In the dashboard: **منابع و توکن‌ها** → enter the Jobvision email + password → **ذخیره و ورود**.
The app logs in with the Edge/Chrome already installed on the PC (hidden window), saves the token, and logs in again by itself whenever the token expires (dashboard and `npm run schedule`).
If the site asks for a captcha or SMS code, tick **نمایش مرورگر** and finish it in the window.
CLI: `npm run ats -- login jobvision --email you@company.com --password "..."` (add `--show` to see the browser).

## Usage
```bash
npm run dry                         # fetch + score, print what would be sent, save nothing
npm run ats -- run                  # real run
npm run ats -- run --source jobinja
npm run schedule                    # run now, then every SCHEDULE_CRON (default 20 min)
npm run ats -- list                 # processed applications
npm run ats -- forget jobinja 123   # re-process one applicant (or whole source without id)
npm test
```
Local testing without the sites: put resumes in `samples/<Job Title>/*.pdf|docx|txt` and enable the `samples` source.

Run the scheduler permanently with `pm2 start "npm run schedule" --name ats` or Windows Task Scheduler / NSSM.

## Notes
- The endpoints are the panel's internal API, not a public one: they can change and tokens expire. On 401/403 you get a 🔐 Telegram alert - paste fresh cookie/token into `.env`.
- Requests are paced (`delayMs`) and polling is every 20 min by default - keep it that way.
- Resumes are personal data: send them only to a private chat, and note resume text is sent to the Claude API for scoring. `.env`, `sources.yaml`, `state/` and `data/` are git-ignored.

## Layout
`src/sources/` (http-source = configurable endpoint client, folder-source = local test) · `src/score.ts` (LLM + keyword + hard filters) · `src/pipeline.ts` · `src/telegram.ts` · `src/db.ts` (node:sqlite) · `src/cli.ts`
