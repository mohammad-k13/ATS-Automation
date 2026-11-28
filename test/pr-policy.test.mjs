import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, ownerApproved } from '../scripts/check-pr-policy.mjs';

const check = (head, base, changed, options = {}) =>
  evaluatePolicy({ head, base, changed, ...options });

test('allows only task, feature integration, and release routes', () => {
  for (const [head, base] of [
    ['task/report-schema', 'feature/reporting'],
    ['feature/reporting', 'dev'],
    ['dev', 'main'],
  ]) assert.equal(check(head, base, 100).error, null);

  for (const [head, base] of [
    ['task/report-schema', 'dev'],
    ['task/report-schema', 'main'],
    ['feature/reporting', 'main'],
    ['dev', 'feature/reporting'],
    ['other/branch', 'feature/reporting'],
  ]) assert.ok(check(head, base, 100).error);
});

test('enforces the task cap, with an owner-approved manual exception', () => {
  assert.equal(check('task/a', 'feature/a', 400).error, null);
  assert.ok(check('task/a', 'feature/a', 401).error);
  assert.equal(check('task/a', 'feature/a', 401, { ownerException: true }).error, null);
  assert.ok(check('task/a', 'feature/a', 401,
    { ownerException: true, autoMerge: true }).error);
  assert.equal(check('feature/a', 'dev', 401).error, null);
});

test('warns outside the target and rejects malformed data', () => {
  assert.equal(check('task/a', 'feature/a', 50).warning, null);
  assert.equal(check('task/a', 'feature/a', 200).warning, null);
  assert.ok(check('task/a', 'feature/a', 49).warning);
  assert.ok(check('task/a', 'feature/a', 201).warning);
  for (const changed of [-1, undefined, '100']) {
    assert.ok(check('task/a', 'feature/a', changed).error);
  }
  assert.ok(check(null, 'feature/a', 100).error);
});

test('requires a current-head owner comment and paginates comments', async () => {
  const event = {
    repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    pull_request: {
      number: 1, head: { sha: 'abc123' },
      labels: [{ name: 'policy:oversize-approved' }],
    },
  };
  const comments = Array.from({ length: 100 }, () => ({
    user: { login: 'someone' }, body: 'other',
  }));
  const requests = [];
  const request = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => requests.length === 1
      ? comments
      : [{ user: { login: 'owner' }, body: 'SIZE_EXCEPTION_APPROVED abc123' }] };
  };
  assert.equal(await ownerApproved(event, request), true);
  assert.equal(requests.length, 2);
  assert.equal(await ownerApproved(event, async () => ({
    ok: true, json: async () => [{ user: { login: 'owner' },
      body: 'SIZE_EXCEPTION_APPROVED stale' }],
  })), false);
  event.pull_request.labels = [];
  assert.equal(await ownerApproved(event, request), false);
});
