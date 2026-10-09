/**
 * The Hono application (SPEC §10.2): `/api/*` route modules plus plugins (rooms, admin; see plugins.ts), JSON errors,
 * and — with `serveStatic` (production) — the built client from DIST_DIR with History-API fallback (`/<ADMIN_PATH>*`
 * → admin.html, everything else → index.html; `/admin.html` and, unless ADMIN_PATH is `admin`, `/admin*` are 404, so
 * the admin shell is found only under its secret path) and the public dataset under `/data` from DATA_DIR (immutable
 * caching for `panos/` and `map/`; any `manifest.json` is refused so a stray private manifest can never leak). Pano
 * files carry no Last-Modified/ETag: a file's mtime tells its world and render order, i.e. roughly where a round
 * starts (the publish step also sets one constant mtime, tools/publish_dataset.py); the keys are immutable, so
 * validators are not needed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiError } from '../shared/api';
import { errorResponse, publicOrigin, services } from './http';
import type { AppContext, AppEnv } from './http';
import type { ServerPlugin } from './plugins';
import { challengesRoutes } from './routes/challenges';
import { configRoutes } from './routes/config';
import { dailyRoutes } from './routes/daily';
import { gamesRoutes } from './routes/games';
import { hitsRoutes } from './routes/hits';
import { playersRoutes } from './routes/players';
import { reportsRoutes } from './routes/reports';
import type { Services } from './services';

export interface AppOptions {
  plugins?: readonly ServerPlugin[];
  /** Serve dist/ and /data (production). Default: `!services.config.dev`. */
  serveStatic?: boolean;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

export function createApp(services: Services, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => errorResponse(c, err));
  app.use('*', async (c, next) => {
    c.set('services', services);
    await next();
  });

  const api = new Hono<AppEnv>();
  api.onError((err, c) => errorResponse(c, err));
  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  api.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: 'bad_request', message: 'body too large' } satisfies ApiError, 413),
    }),
  );
  api.get('/health', (c) => c.json({ ok: true, worlds: [...services.worlds.keys()] }));
  api.route('/', playersRoutes());
  api.route('/', gamesRoutes());
  api.route('/', challengesRoutes());
  api.route('/', dailyRoutes());
  api.route('/', hitsRoutes());
  api.route('/', configRoutes());
  api.route('/', reportsRoutes());
  for (const plugin of opts.plugins ?? []) plugin.routes?.(api, services);
  // Catch-all after every route and plugin (a mounted sub-app's notFound handler is not consulted by Hono).
  api.all('*', (c) => c.json({ error: 'not_found', message: 'no such endpoint' } satisfies ApiError, 404));
  app.route('/api', api);

  if (opts.serveStatic ?? !services.config.dev) mountStatic(app, services);
  return app;
}

function mountStatic(app: Hono<AppEnv>, services: Services): void {
  const { dataDir, distDir } = services.config;

  app.use('/data/*', async (c, next) => {
    if (/\/manifest\.json$/i.test(c.req.path)) return c.notFound();
    await next();
  });
  app.use('/data/panos/*', async (c, next) => {
    await next();
    c.res.headers.delete('Last-Modified');
    c.res.headers.delete('ETag');
  });
  app.use(
    '/data/*',
    serveStatic({
      root: dataDir,
      rewriteRequestPath: (p) => p.replace(/^\/data/, ''),
      onFound: (path, c) => {
        const rel = path.slice(dataDir.length).replace(/\\/g, '/');
        const immutable = /^\/(?:panos\/|[^/]+\/map\/)/.test(rel);
        c.header('Cache-Control', immutable ? IMMUTABLE : 'public, max-age=300');
      },
    }),
  );
  app.all('/data/*', (c) => c.text('Not found', 404));

  app.use(
    '/assets/*',
    serveStatic({ root: distDir, onFound: (_p, c) => c.header('Cache-Control', IMMUTABLE) }),
  );
  // The game shell is never served as a plain file: its Open Graph tags need the absolute origin (see shellHtml).
  app.get('/', (c) => sendShell(c, 'index.html'));
  app.get('/index.html', (c) => sendShell(c, 'index.html'));
  // Nor the admin shell: it exists only under /<ADMIN_PATH> (it gets the path injected there).
  app.get('/admin.html', (c) => c.text('Not found', 404));
  app.use(
    '*',
    serveStatic({
      root: distDir,
      // HTML shells must revalidate so a new build's hashed assets are picked up at once.
      onFound: (p, c) => c.header('Cache-Control', p.endsWith('.html') ? 'no-cache' : 'public, max-age=300'),
    }),
  );

  // History-API fallback: client routes (/play, /daily, /c/<code>, /r/<CODE>, /<ADMIN_PATH>…) get the SPA shell.
  const { adminPath } = services.config;
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path === '/ws') return c.notFound();
    if (/\.[a-z0-9]{1,8}$/i.test(c.req.path)) return c.text('Not found', 404); // missing asset, not a route
    if (isUnder(c.req.path, adminPath)) return sendShell(c, 'admin.html');
    // The well-known location answers like a missing file, not with the game shell (no hint that an admin exists).
    if (isUnder(c.req.path, 'admin')) return c.text('Not found', 404);
    return sendShell(c, 'index.html');
  });
}

/** `/<segment>` or `/<segment>/…` (an exact, case-sensitive first path segment). */
function isUnder(path: string, segment: string): boolean {
  return path === `/${segment}` || path.startsWith(`/${segment}/`);
}

/**
 * An HTML shell from dist/ with `%ORIGIN%` replaced by the public origin. Link previews (Telegram, WhatsApp, VK…)
 * want absolute `og:image` / `og:url`, and the origin is only known at run time (PUBLIC_ORIGIN or the request).
 * `adminPath` (admin.html only, never the game shell) fills `%ADMIN_PATH%`: the admin SPA routes and calls its API
 * under it (src/admin/base.ts).
 */
export function shellHtml(raw: string, origin: string, adminPath?: string): string {
  const html = raw.replaceAll('%ORIGIN%', origin.replace(/[<>"&]/g, ''));
  return adminPath === undefined ? html : html.replaceAll('%ADMIN_PATH%', adminPath.replace(/[^A-Za-z0-9_-]/g, ''));
}

function sendShell(c: AppContext, name: 'index.html' | 'admin.html'): Response {
  const { distDir, adminPath } = services(c).config;
  const path = join(distDir, name);
  if (!existsSync(path)) return c.text('Not found', 404);
  c.header('Cache-Control', 'no-cache');
  const raw = readFileSync(path, 'utf8');
  return c.html(name === 'admin.html' ? shellHtml(raw, publicOrigin(c), adminPath) : shellHtml(raw, publicOrigin(c)));
}
