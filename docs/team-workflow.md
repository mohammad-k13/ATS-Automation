# Team workflow: ClickUp + GitHub

ClickUp is where work is **planned and tracked**; GitHub is where it is **built and reviewed**. Every pull request links a ClickUp task and every task links its pull request.

## ClickUp space (private)
A dedicated **private Space** called **ATS** holds only this project, so people can be invited to it without seeing any other board. Invite people to the Space (not the whole Workspace) as *Member* or *Guest*.

```
ATS (private Space)
├── 📁 Product
│   ├── 📋 Backlog          ideas and requests, not yet planned
│   ├── 📋 Sprint           current work (2-week sprints)
│   └── 📋 Bugs             problems found in real use
├── 📁 Operations
│   ├── 📋 Server & releases   installs, updates, rollbacks, access
│   └── 📋 Real-site checks    things only a person on the server can verify (Jobvision, Google Sheet)
└── 📄 Docs                 how to work here, decisions, meeting notes
```

### Statuses (same for every list)
`Backlog → To do → In progress → In review → Ready to deploy → Done`

| Status | Means |
| --- | --- |
| Backlog | Not planned |
| To do | Planned for this sprint, nobody started |
| In progress | Someone has a branch |
| In review | Pull request open |
| Ready to deploy | Merged; waiting for the server to update |
| Done | Live and checked on the server |

### Tags
Area: `ui`, `scoring`, `jobvision`, `google-sheet`, `export`, `deploy`, `ai`, `docs`.
Kind: `bug`, `feature`, `chore`. Priority uses ClickUp's built-in priority field.

## Writing a good task
- **Title**: what a user sees ("Attached resume downloads"), not the code change.
- **Description**: the problem, how to check it, and "done when".
- **One owner.** Anyone can help, one person is accountable.
- Bugs: steps, expected vs actual, and **no personal data or secrets**.

## Rhythm
- **Planning (every other Sunday, 30 min)**: pick from Backlog into Sprint; limit work in progress to two tasks per person.
- **Async status**: a short note on the task when you start, get blocked, or finish. No daily meeting needed.
- **Review**: aim to review a PR within a working day.
- **Retro (end of sprint, 15 min)**: what to keep, what to change; write it in the Docs.

## Linking
- Put the ClickUp task URL in the pull request description.
- Branch names may include the task id: `fix/86abc123-attachment-401`.
- Paste the PR link in the task; ClickUp's GitHub integration (Workspace settings → Integrations) can do both automatically once connected.

## Roles
| Role | Does |
| --- | --- |
| Owner | Sets priorities, reviews `deploy/`, `src/auth/`, `.github/`, merges releases |
| Developer | Takes tasks, opens PRs, reviews others' PRs |
| Recruiter / tester | Uses the dashboard, files bugs and feature requests, checks "Real-site checks" |
