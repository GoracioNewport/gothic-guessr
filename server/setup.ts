/**
 * `npm run setup`: create `.env.local` with a random ADMIN_PASSWORD, SERVER_SECRET and ADMIN_PATH when they are
 * missing (existing values and other lines are kept). Never prints the values; the file is written with mode 0600.
 * Read them with `grep ADMIN_ .env.local` when you need them: the admin is at `/<ADMIN_PATH>`.
 * The logic lives in env-local.ts; the server imports it from there, never this entry module.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEnvLocal } from './env-local';

export { ensureEnvLocal };

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const path = resolve(root, '.env.local');
  const added = ensureEnvLocal(path);
  console.log(added.length > 0 ? `setup: wrote ${added.join(', ')} to ${path}` : `setup: ${path} already has the secrets`);
  console.log("setup: the admin UI is at /<ADMIN_PATH>; read it with: grep ADMIN_ .env.local");
}
