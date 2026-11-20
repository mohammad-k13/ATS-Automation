## What and why

<!-- One or two sentences. Link the ClickUp task: https://app.clickup.com/t/... -->

## How to check it

<!-- Steps a reviewer can follow, or the test that covers it. -->

## Checklist

- [ ] `npm run check` and `npm run format:check` pass
- [ ] No tokens, cookies, passwords, HAR files or real candidate data in the diff
- [ ] Phone numbers / personal data are not sent to the AI
- [ ] Anything that writes to Jobvision (status change, reject) still asks for confirmation
- [ ] UI text is Persian and the page works in RTL, light and dark
- [ ] README / docs updated if behaviour or setup changed

> `main` is deployed to the server automatically (every 30 minutes). Merge only what you are happy to see live.
