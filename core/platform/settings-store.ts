/**
 * Settings saved from the dashboard (tokens, passwords, AI/Telegram/Sheet keys).
 *
 * They used to be appended to .env, but .env readers mangle values: a password like `Pa$$w0rd#24`
 * came back as `Pa$` (`$` is variable expansion, `#` starts a comment) and a line break could inject
 * other settings. So they live in a JSON file next to the database instead, stored exactly as typed,
 * and are applied on top of process.env when the app starts. .env stays for startup values only.
 */
import fs from 'node:fs';
import path from 'node:path';

const file = () =>
      path.join(path.dirname(path.resolve(process.env.DB_PATH || 'data/ats.db')), 'settings.json');

function read(): Record<string, string> {
      try {
            const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
            return data && typeof data === 'object' ? data : {};
      } catch {
            return {};
      }
}

const g = globalThis as unknown as { __atsSettingsLoaded?: boolean };

/** Apply saved settings to process.env (once per process; safe to call many times). */
export function loadSettings() {
      if (g.__atsSettingsLoaded) return;
      g.__atsSettingsLoaded = true;
      for (const [k, v] of Object.entries(read())) if (typeof v === 'string') process.env[k] = v;
}

/** Save one setting exactly as given and apply it now. */
export function saveSetting(key: string, value: string) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`bad setting name: ${key}`);
      const data = read();
      data[key] = value;
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      const tmp = `${file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file()); // atomic: never a half-written file
      process.env[key] = value;
}

loadSettings();
