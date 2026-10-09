/**
 * Server entry (SPEC §10.2): load `.env.local` + env, open the DB, load the worlds, start HTTP on PORT/API_PORT and
 * attach the plugins (rooms' WebSocket hub at /ws). Dev: `npm run dev:server` (tsx watch); prod: `npm run build`
 * bundles this file into dist-server/main.js (`build:server`, esbuild, npm packages stay external) and `npm start`
 * runs it with plain node. The bundle sits one level below the project root like this file, so `root` is the same.
 * In dev a missing `.env.local` secret is generated on the fly (same as `npm run setup`), in production it is fatal.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig, loadEnv } from './config';
import type { Config } from './config';
import { openDatabase } from './db/database';
import { SqliteRepository } from './db/repository';
import { PLUGINS } from './plugins';
import { createServices } from './services';
import { ensureEnvLocal } from './env-local';
import { loadWorldRegistry } from './worlds';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function config(): Config {
  try {
    return loadConfig(loadEnv(root), root);
  } catch (err) {
    const devMode = process.env.NODE_ENV !== 'production' && process.env.DEV !== '0';
    if (!devMode) throw err;
    // ADMIN_PATH stays unset here (dev default `admin`): Vite, started next to this process, has already read the env.
    const added = ensureEnvLocal(resolve(root, '.env.local'), { adminPath: false });
    if (added.length > 0) console.log(`[server] created ${added.join(', ')} in .env.local`);
    return loadConfig(loadEnv(root), root);
  }
}

const cfg = config();
const { worlds, skipped } = loadWorldRegistry(cfg.dataDir, cfg.serverDataDir);
for (const s of skipped) console.warn(`[server] world ${s.slug} skipped: ${s.error}`);
if (worlds.size === 0) console.warn(`[server] no worlds loaded from ${cfg.serverDataDir}: games cannot be created`);

const db = openDatabase(cfg.dbPath);
const services = createServices({ config: cfg, repo: new SqliteRepository(db), worlds });
// Rooms live in memory: room games a previous process left `running` are finished now (SPEC §10.6).
try {
  const recovered = await services.games.recoverRoomChallenges();
  if (recovered.length > 0) console.log(`[server] finished ${recovered.length} room game(s) left running by a previous process`);
} catch (err) {
  console.error('[server] room game recovery failed', err);
}
const app = createApp(services, { plugins: PLUGINS });

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  const mode = cfg.dev ? 'dev' : 'production';
  console.log(`[server] ${mode} API on http://${cfg.host ?? '0.0.0.0'}:${info.port} — worlds: ${[...worlds.keys()].join(', ') || 'none'}`);
});
for (const plugin of PLUGINS) plugin.attach?.(server, services);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[server] ${signal}: shutting down`);
  for (const plugin of PLUGINS) await plugin.close?.();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
