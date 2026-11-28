# ATS-Automation — Agent Instructions

## Product principles

Build a commercially ready, self-hosted recruitment platform that is intuitive, secure, reliable, and easy to integrate. Keep the interface Persian-first and RTL.

- Use shadcn/ui for all new or redesigned UI. Reuse shared components and preserve accessible keyboard behavior.
- Keep product planning in ClickUp. Use GitHub Issues as
  the primary source of truth for engineering tasks,
  acceptance criteria, dependencies, and progress.
  GitHub Projects is optional and must not block development.
- Target the commercial v1.0 release by December 18, 2026.
- Never expose credentials, cookies, or real candidate data in code, logs, tests, issues, or pull requests.
- Keep human acceptance and merge authority with the repository owner. Never merge or enable auto-merge without explicit approval.

## Mandatory six-step lifecycle

Every task follows these steps. Scale the detail to the task, but do not skip a step.

1. **Product** — State the user problem, value, scope, edge cases, and measurable acceptance criteria in a GitHub issue. Link the ClickUp product task when one exists.
2. **UX** — Describe the user journey, states, and interactions. For UI work, specify shadcn/ui components and Persian RTL behavior, including loading, empty, error, success, and permission-denied states.
3. **Technical** — Inspect the existing architecture, identify affected areas and dependencies, define a brief and test scenarios, and split work into independently reviewable tasks.
4. **Code** — Implement only the approved brief on a task branch. Keep changes focused; the test agent derives tests from the brief independently.
5. **Review** — Obtain an independent review against the brief, acceptance criteria, security, regressions, and tests. Run relevant CI checks and report actual results only.
6. **Acceptance** — The owner reviews the pull request and decides whether to merge. A passing CI or agent review is not merge approval.

## Branches and pull requests

- `main` is production; never push directly to it. `dev` remains the release integration branch; do not change production deployment behavior.
- Create `feature/<name>` as the integration branch for one feature, based on `dev`.
- Create short-lived `task/<name>` branches from the current feature branch. Open task pull requests into that feature branch, not directly into `dev` or `main`.
- Once a feature is complete and accepted, propose a separate integration pull request from its feature branch to `dev`.
- Target 50–200 changed lines and one responsibility per pull request. Split work before implementation when it cannot fit.
- Do not exceed 400 changed lines or 10 files without explicit owner approval. Isolate generated files, dependency updates, and mechanical migrations where practical.
- Do not stack unrelated changes or silently expand scope. Never merge a pull request without explicit owner approval.

## Agent independence

Use separate coding, test-writing, and review agents when those capabilities are available. The test agent writes cases from the approved brief without relying on the implementation. The reviewer checks the final implementation and test coverage independently. Verify model availability before assigning model-specific work. Never claim an agent ran, a model was used, or a test passed unless that execution was observed; state unavailable capabilities plainly.

## Engineering standards

- Follow existing project layering: framework-independent logic stays in `core/`; UI stays in `app/`.
- Keep provider integrations behind typed interfaces and enforce authorization on the server.
- Prefer backward-compatible data changes and persistent processing for critical operations.
- Test failure cases, permission boundaries, retries, and user-visible states when relevant. Do not weaken tests to hide defects.
- For UI changes, check Persian RTL layout and light/dark themes and include visual evidence where practical.
- Record known limitations and unresolved decisions in the pull request.

## Ready for owner review

A task is ready when its acceptance criteria are addressed, relevant checks have actually run, independent review status is stated accurately, CI status is visible, and remaining risks are documented. The owner alone decides acceptance and merge.
