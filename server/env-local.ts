/**
 * `.env.local` secrets (SPEC §10.2): {@link ensureEnvLocal} adds a random ADMIN_PASSWORD, SERVER_SECRET and
 * ADMIN_PATH (`admin-` + 16 base32 chars) when they are missing (existing values and other lines are kept). Never
 * prints the values; the file is written with mode 0600.
 * Kept apart from setup.ts (the `npm run setup` entry) so that bundling main.ts never pulls in setup's
 * "am I the entry point" check: in a single-file bundle that check would see the bundle as the entry and run.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnvFile } from './config';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A random ADMIN_PATH: `admin-` + 16 base32 chars (80 bits), valid for config.ts parseAdminPath. */
export function randomAdminPath(): string {
  let out = 'admin-';
  for (let i = 0; i < 16; i++) out += BASE32[randomInt(32)];
  return out;
}

/**
 * Add the missing secrets to the env file at `path`; returns the names that were added. `adminPath: false` leaves
 * ADMIN_PATH out (the dev server's on-the-fly fallback: a Vite already running would keep serving `/admin`).
 */
export function ensureEnvLocal(path: string, opts: { adminPath?: boolean } = {}): string[] {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const env = parseEnvFile(text);
  const added: string[] = [];
  const lines: string[] = [];
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
    lines.push(`ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}`);
    added.push('ADMIN_PASSWORD');
  }
  if (!env.SERVER_SECRET || env.SERVER_SECRET.length < 16) {
    lines.push(`SERVER_SECRET=${randomBytes(32).toString('hex')}`);
    added.push('SERVER_SECRET');
  }
  if ((opts.adminPath ?? true) && !env.ADMIN_PATH?.trim()) {
    lines.push(`ADMIN_PATH=${randomAdminPath()}`);
    added.push('ADMIN_PATH');
  }
  if (lines.length > 0) {
    const header = text === '' ? '# Local secrets of Gothic II Guessr (git-ignored). Created by `npm run setup`.\n' : '';
    const sep = text !== '' && !text.endsWith('\n') ? '\n' : '';
    writeFileSync(path, `${header}${text}${sep}${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return added;
}
