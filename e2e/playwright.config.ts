/**
 * Playwright e2e suite (SPEC §10.11): full flows against the real dataset on the `npm run dev` stack, on its own
 * ports so it never clashes with a running dev server:
 *
 *   API  (server/main.ts, tsx, dev mode)  http://localhost:9787   E2E_API_PORT
 *   Vite (proxies /api and /ws to the API) http://localhost:6173   E2E_PORT  (e2e/vite.config.ts: no HMR, no watch)
 *
 * Every run gets a fresh temporary directory (E2E_RUN_DIR) holding the SQLite database (DB_PATH) and the recorded
 * /api, /data and WebSocket bodies the leak check reads; it is deleted by global-teardown.ts. The admin password,
 * the admin path (ADMIN_PATH, given to both the API and Vite) and the server secret of the run are random and live
 * only in this process's environment (never printed); the real `.env.local` secrets are not used. TRUST_PROXY=1 lets
 * each browser context present its own X-Forwarded-For address, so the per-IP limits (10 new players per hour) do
 * not throttle a suite that creates more players; Vite's proxy forwards the header unchanged (no `xfwd`), so it is
 * both the first and the last entry the API sees.
 *
 * Projects run in order: `flows` (solo, daily, challenge, party, duel, languages) → `admin` (stats must include the
 * games just played) → `leak` (crawls everything recorded so far, probes the private data).
 *
 * Run: `npm run e2e` (Chromium must be installed: `npx playwright install chromium`).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The config is evaluated again in every worker: keep the first evaluation's values (workers inherit the env).
process.env.E2E_RUN_DIR ??= mkdtempSync(join(tmpdir(), 'g2-e2e-'));
process.env.E2E_ADMIN_PASSWORD ??= randomBytes(18).toString('base64url');
process.env.E2E_SERVER_SECRET ??= randomBytes(32).toString('base64url');
// Same shape as `npm run setup` / deploy/scripts/secrets.sh write: `admin-` + 16 lowercase base32 chars.
process.env.E2E_ADMIN_PATH ??= `admin-${[...randomBytes(16)].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('')}`;
process.env.E2E_API_PORT ??= '9787';
process.env.E2E_PORT ??= '6173';

const apiPort = process.env.E2E_API_PORT;
const port = process.env.E2E_PORT;
const runDir = process.env.E2E_RUN_DIR;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.e2e\.ts$/,
  outputDir: './.output',
  globalTeardown: './global-teardown.ts',
  // One worker: the flows share one server, one database and one daily; parallel WebGL contexts would also make
  // the timing-sensitive steps (countdowns, duel 15 s) flaky on a laptop.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'flows', testMatch: /flows\/.*\.e2e\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
    {
      name: 'admin',
      testMatch: /admin\.e2e\.ts$/,
      dependencies: ['flows'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    { name: 'leak', testMatch: /leak\.e2e\.ts$/, dependencies: ['admin'], use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      name: 'api',
      command: 'npx tsx server/main.ts',
      cwd: root,
      url: `http://localhost:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: {
        NODE_ENV: 'development',
        DEV: '1',
        API_PORT: apiPort,
        DB_PATH: join(runDir, 'db.sqlite'),
        TRUST_PROXY: '1',
        ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD,
        ADMIN_PATH: process.env.E2E_ADMIN_PATH,
        SERVER_SECRET: process.env.E2E_SERVER_SECRET,
      },
    },
    {
      name: 'vite',
      command: `npx vite --config e2e/vite.config.ts --port ${port} --strictPort`,
      cwd: root,
      url: `http://localhost:${port}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      // Its stderr only repeats the "outside of Vite serving allow list" refusals the leak probes provoke.
      stderr: 'ignore',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
      env: { API_PORT: apiPort, ADMIN_PATH: process.env.E2E_ADMIN_PATH },
    },
  ],
});
