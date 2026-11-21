import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('saved settings keep every character (passwords with $ # quotes, line breaks)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-settings-'));
  process.env.DB_PATH = path.join(dir, 'ats.db');
  const { saveSetting } = await import('../core/platform/settings-store');
  const nasty = 'Pa$$w0rd#2024 \'q\' "d" \\back\nATS_PASSWORD_HASH=';
  saveSetting('JOBVISION_PASSWORD', nasty);
  assert.equal(process.env.JOBVISION_PASSWORD, nasty);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(stored.JOBVISION_PASSWORD, nasty);
  assert.equal(stored.ATS_PASSWORD_HASH, undefined, 'a line break must not create another setting');
  // Windows has no Unix file modes (always reports 0o666); the check only means something elsewhere
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  assert.throws(() => saveSetting('bad key', 'x'));
  fs.rmSync(dir, { recursive: true });
});
