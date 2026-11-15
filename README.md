# ATS Automation

Custom ATS for your company: pulls applicants from your **Jobinja / Jobvision employer panel** (via the panel's own JSON endpoints), scores each resume against your per-job criteria (Claude API, Persian + English), and sends **only accepted candidates** (summary + resume file) to Telegram. Rejected candidates are listed in a digest so nothing is silently dropped. Runs on demand or on a schedule; SQLite makes sure nobody is processed or sent twice.

## Setup (Windows / Linux, Node 22.13+)
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
5. **Claude API** - set `ANTHROPIC_API_KEY`. Without it, keyword-only scoring is used.

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
