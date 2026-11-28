## What and why

<!-- Describe the user problem and change. Link the engineering issue and ClickUp task. -->

- GitHub issue:
- ClickUp task:

## Branches and scope

- Source branch:
- Target branch: <!-- Task PRs target feature/<name>; feature integration PRs target dev. -->
- Included:
- Follow-up work:
- Risk and rollback:

<!-- Target 50–200 changed lines and one responsibility. More than 400 lines or 10 files requires owner approval. -->

## Reviewer guide

<!-- Give reproducible steps, inputs, and expected results. Point to the most important files. -->

1.
2.

- Focus areas:
- Known limitations:

## Actual validation

<!-- Record only checks actually run. Use "not run" with a reason if needed. -->

| Check | Command or run link | Result | Notes |
| --- | --- | --- | --- |
| `npm run check` | | | |
| `npm run format:check` | | | |
| Relevant tests | | | |
| GitHub CI | | | |

## Independent agent evidence

<!-- State the agent/model actually used, or "not performed". Do not infer execution from configuration. -->

- Coding agent and scope:
- Test agent, brief-based scenarios, and results:
- Review agent, commit reviewed, and findings:
- Fixes and re-review:

## Checklist

- [ ] No tokens, cookies, passwords, HAR files or real candidate data in the diff
- [ ] Phone numbers / personal data are not sent to the AI
- [ ] Anything that writes to Jobvision (status change, reject) still asks for confirmation
- [ ] UI text is Persian and the page works in RTL, light and dark, where affected
- [ ] New or redesigned UI uses shadcn/ui, where affected
- [ ] README / docs updated if behaviour or setup changed

## Human acceptance

- [ ] Owner approval is recorded before merge
- [ ] Target branch and deployment impact reviewed

> `main` is deployed to the server automatically (every 30 minutes). Merge only after human approval.
