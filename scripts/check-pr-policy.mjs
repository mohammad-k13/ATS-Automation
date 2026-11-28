import { readFile } from 'node:fs/promises';

export function evaluatePolicy({ head, base, changed, ownerException = false, autoMerge = false }) {
  if (typeof head !== 'string' || typeof base !== 'string' ||
      !Number.isInteger(changed) || changed < 0) {
    return { error: 'Invalid pull request data.' };
  }

  const task = /^task\/[^/]+$/.test(head);
  const feature = /^feature\/[^/]+$/.test(head);
  const route =
    (task && /^feature\/[^/]+$/.test(base)) ||
    (feature && base === 'dev') ||
    (head === 'dev' && base === 'main');
  if (!route) {
    return { error: 'Allowed routes: task/* → feature/*, feature/* → dev, dev → main.' };
  }

  const warning = task && (changed < 50 || changed > 200)
    ? `Task PR has ${changed} changed lines; target is 50–200.`
    : null;
  if (task && changed > 400 && (!ownerException || autoMerge)) {
    return { error: 'Task PR exceeds 400 lines. A current-head owner approval and manual merge are required.', warning };
  }
  return { error: null, warning };
}

export async function ownerApproved(event, request = fetch) {
  const pr = event.pull_request;
  if (!pr.labels?.some(({ name }) => name === 'policy:oversize-approved')) return false;
  const owner = event.repository.owner.login.toLowerCase();
  const marker = `SIZE_EXCEPTION_APPROVED ${pr.head.sha}`;
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${event.repository.full_name}/issues/${pr.number}/comments?per_page=100&page=${page}`;
    const response = await request(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`Unable to verify owner comment: HTTP ${response.status}`);
    const comments = await response.json();
    if (comments.some((comment) =>
      comment.user?.login?.toLowerCase() === owner && comment.body?.trim() === marker)) return true;
    if (comments.length < 100) return false;
  }
}

if (process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr) throw new Error('pull_request event required');
  const changed = pr.additions + pr.deletions;
  const exception = changed > 400 && pr.head.ref.startsWith('task/')
    ? await ownerApproved(event)
    : false;
  const result = evaluatePolicy({
    head: pr.head.ref, base: pr.base.ref, changed,
    ownerException: exception, autoMerge: Boolean(pr.auto_merge),
  });
  if (result.warning) console.warn(`::warning::${result.warning}`);
  if (result.error) {
    console.error(`::error::${result.error}`);
    process.exitCode = 1;
  }
}
