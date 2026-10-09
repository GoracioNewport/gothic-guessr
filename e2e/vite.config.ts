/**
 * Vite config of the e2e stack: the project's config (vite.config.ts: proxy, fs.deny, admin fallback) with HMR and
 * file watching off, so edits made while a run is in progress cannot reload the pages under test mid-flow.
 * Vite's root stays the working directory (the project root; playwright.config.ts starts it there).
 */
import type { UserConfig } from 'vite';
import base from '../vite.config';

const config: UserConfig = {
  ...base,
  server: { ...base.server, hmr: false, watch: null },
};

export default config;
