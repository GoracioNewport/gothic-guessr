import { cpSync, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';
import { configDefaults } from 'vitest/config';

/**
 * Unit tests that read the real dataset (the private Khorinis manifest and the public world files, git-ignored and built
 * from your own copy of the game, see README). In a fresh clone without the dataset they are skipped, not failed.
 */
const DATASET_TESTS = ['tests/graph.test.ts', 'tests/rounds.test.ts', 'tests/state.test.ts', 'tests/starts-in-frame.test.ts', 'tests/worlds.test.ts'];
const hasDataset = existsSync('server-data/khorinis/manifest.json') && existsSync('public/data/khorinis/world.json');

/**
 * Copy `public/ui` (the Gothic UI assets, a few MB) into the build output. `copyPublicDir` is off
 * because of the dataset (below), but the fonts, frames, logo and thumbnails are part of the app:
 * style.css, index.html and screens.ts reference them as `/ui/gothic/...`.
 * The assets come from the game and are not in the repository: `npm run assets` extracts them from your own copy
 * (tools/build_assets.sh). Without them the build stops with that hint; the dev server only warns.
 */
function copyUiAssets(): Plugin {
  const from = fileURLToPath(new URL('./public/ui', import.meta.url));
  // Files every page needs (extract_ui_assets.py + build_webfont.py), and ones only some features use.
  const required = ['index.json', 'favicon.ico', 'MENU_BACK_ADDON.webp', 'fonts/GothicOld.woff2', 'fonts/GothicDefault.woff2'];
  const optional = ['og-image.jpg', 'fonts/GothicOldRU.woff2', 'fonts/GothicOldPL.woff2'];
  const missing = (files: string[]): string[] => files.filter((f) => !existsSync(join(from, 'gothic', f)));
  const hint =
    'The Gothic II UI assets are not in the repository: build them from your own copy of the game with ' +
    '`GOTHIC2_DIR="/path/to/Gothic II" npm run assets` (README, "Reproduce from your own copy of the game").';
  let config: ResolvedConfig;
  return {
    name: 'g2-copy-ui-assets',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer() {
      const absent = missing(required);
      if (absent.length) config.logger.warn(`g2-copy-ui-assets: public/ui/gothic lacks ${absent.join(', ')}. ${hint}`);
    },
    buildStart() {
      if (config.command !== 'build') return;
      const absent = missing(required);
      if (absent.length) throw new Error(`public/ui/gothic lacks ${absent.join(', ')}.\n${hint}`);
      const partial = missing(optional);
      if (partial.length) {
        config.logger.warn(`g2-copy-ui-assets: no ${partial.join(', ')} (link preview / ru, pl fonts). ${hint}`);
      }
    },
    closeBundle() {
      if (config.command !== 'build') return;
      const readme = join(from, 'README.md');
      cpSync(from, resolve(config.root, config.build.outDir, 'ui'), { recursive: true, filter: (src) => src !== readme });
    },
  };
}

/**
 * Admin SPA (admin.html, src/admin/): serve its shell for `/<ADMIN_PATH>` and `/<ADMIN_PATH>/<route>` in dev and
 * preview (Vite's own SPA fallback would answer with index.html) and fill its `%ADMIN_PATH%` in dev; a direct
 * `/admin.html` is 404, and so is `/admin*` when ADMIN_PATH is something else. Production does the same in server/app.ts. ADMIN_PATH comes from the environment or
 * `.env.local` like the API server's (`admin` when unset, as the server's dev default).
 */
function adminFallback(adminPath: string): Plugin {
  const base = `/${adminPath}`;
  const rewrite = (req: { url?: string; method?: string }, res: ServerResponse, next: () => void): void => {
    const [path, query = ''] = (req.url ?? '').split('?');
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // As in production: no admin shell at /admin.html, nor at /admin* unless that is ADMIN_PATH (Vite's own fallback
    // would answer /admin with admin.html).
    const wellKnown = adminPath !== 'admin' && (path === '/admin' || path!.startsWith('/admin/'));
    if ((path === '/admin.html' && !query.includes('html-proxy')) || wellKnown) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    if (path === base || (path!.startsWith(`${base}/`) && !/\.[a-z0-9]{1,8}$/i.test(path!))) req.url = '/admin.html';
    next();
  };
  return {
    name: 'g2-admin-fallback',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
    transformIndexHtml(html, ctx) {
      // Dev only: the built admin.html keeps the placeholder for the server to fill at run time.
      return ctx.server ? html.replaceAll('%ADMIN_PATH%', adminPath) : html;
    },
  };
}

/**
 * Pano tiles under /data/panos/ go out without Last-Modified/ETag in dev too (server/app.ts does the same in
 * production): a file's mtime would tell its world and render order. Conditional request headers are dropped so
 * Vite's static server cannot answer 304 to a guessed validator either.
 */
function panoValidators(): Plugin {
  const VALIDATOR = /^(?:last-modified|etag)$/i;
  const strip = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if ((req.url ?? '').startsWith('/data/panos/')) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
      // The static server sets them either with setHeader or in the writeHead headers object.
      const setHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: number | string | readonly string[]) =>
        VALIDATOR.test(name) ? res : setHeader(name, value)) as ServerResponse['setHeader'];
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      res.writeHead = ((...args: unknown[]) => {
        for (const arg of args.slice(1)) {
          if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
            for (const k of Object.keys(arg)) if (VALIDATOR.test(k)) delete (arg as Record<string, unknown>)[k];
          }
        }
        res.removeHeader('last-modified');
        res.removeHeader('etag');
        return writeHead(...args);
      }) as ServerResponse['writeHead'];
    }
    next();
  };
  return {
    name: 'g2-pano-validators',
    configureServer(server) {
      server.middlewares.use(strip);
    },
    configurePreviewServer(server) {
      server.middlewares.use(strip);
    },
  };
}

// Dev: the API server (server/main.ts, `npm run dev:server`) listens on API_PORT (default 8787; also read from
// .env.local); Vite proxies /api and the /ws WebSocket to it so the client uses same-origin URLs.
const fileEnv = loadEnv('development', process.cwd(), '');
const apiPort = process.env.API_PORT || fileEnv.API_PORT || '8787';
const apiTarget = `http://localhost:${apiPort}`;
const adminPath = (process.env.ADMIN_PATH || fileEnv.ADMIN_PATH || '').trim() || 'admin';
if (!/^[A-Za-z0-9_-]{4,64}$/.test(adminPath)) throw new Error('vite.config: ADMIN_PATH must be 4-64 chars of A-Z a-z 0-9 _ -');

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'e2e/**', ...(hasDataset ? [] : DATASET_TESTS)] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
      '/ws': { target: apiTarget, ws: true },
    },
    // The dev server serves any file under the project root (also through /@fs/ and `/data/../`), which would expose
    // the private manifests (SPEC §10.3): server-data/ and the pipeline output out/. Vite's own defaults are kept.
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server-data/**', '**/out/**', '**/*.sqlite*'] },
  },
  preview: { port: 5173, strictPort: true },
  // The dataset under public/data is served as-is in dev and deployed separately in production
  // (`VITE_DATA_BASE`, or copied/symlinked next to dist/); copying it into dist/ on every build
  // would duplicate ~9 GB and take minutes. `npm run preview` needs `ln -s ../public/data dist/data`.
  // public/ui is copied by the plugin above.
  // The entry chunk is small; the viewer chunk (three.js + Photo Sphere Viewer, ~670 kB) is loaded
  // lazily by main.ts while the start screen is up, so its size is expected.
  build: {
    target: 'es2022',
    copyPublicDir: false,
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  plugins: [copyUiAssets(), adminFallback(adminPath), panoValidators()],
});
