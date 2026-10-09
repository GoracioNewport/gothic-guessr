/**
 * Boot (SPEC §10.7): language, the public world data (worlds.json + every world.json, failures isolated per world),
 * the API client, then the app shell (src/app.ts) takes over routing. The viewers (Photo Sphere Viewer + three.js,
 * Leaflet) are a separate chunk the app starts loading while the menu is up.
 */
import '@photo-sphere-viewer/core/index.css';
import 'leaflet/dist/leaflet.css';
import './style.css';

import { App } from './app';
import { loadPublicWorlds } from './data/worlds';
import { initLanguage, t } from './i18n';
import { ApiClient } from './net/api';

/** A boot message (loading or a fatal error) in a game panel. */
function showBootMessage(root: HTMLElement, text: string, isError = false): void {
  root.classList.add('g2-root');
  const screen = document.createElement('div');
  screen.className = 'g2-screen g2-centered g2-boot';
  const card = document.createElement('div');
  card.className = 'g2-card g2-boot-card';
  const p = document.createElement('p');
  p.className = isError ? 'g2-boot-text g2-boot-error' : 'g2-boot-text';
  p.textContent = text;
  p.setAttribute(isError ? 'role' : 'aria-live', isError ? 'alert' : 'polite');
  card.appendChild(p);
  screen.appendChild(card);
  root.replaceChildren(screen);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');
  // Language first (stored choice, else the browser's): sets <html lang> for the fonts, then every text.
  initLanguage();
  showBootMessage(root, t('boot.loading'));
  let worlds;
  try {
    worlds = await loadPublicWorlds();
  } catch (err) {
    console.error(err);
    showBootMessage(root, t('boot.indexFailed', { error: errorText(err) }), true);
    return;
  }
  for (const f of worlds.failed) console.warn(`World "${f.slug}" is unavailable: ${f.error}`);
  if (worlds.worlds.size === 0) {
    showBootMessage(root, t('boot.noWorlds', { details: worlds.failed.map((f) => `${f.slug}: ${f.error}`).join('; ') }), true);
    return;
  }
  root.replaceChildren();
  const app = new App(root, new ApiClient(), worlds);
  if (import.meta.env.DEV) (window as unknown as { __g2: App }).__g2 = app;
  app.start();
}

main().catch((err: unknown) => console.error(err));
