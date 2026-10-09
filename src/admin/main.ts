/**
 * Admin SPA entry (SPEC §10.10; second Vite entry `admin.html`, served for `/<ADMIN_PATH>*`, see base.ts). English
 * only, plain DOM.
 *
 * Shell: login screen until `GET /api/<ADMIN_PATH>/session` succeeds, then a sidebar + the routed page. Routes
 * (History API), all under `/<ADMIN_PATH>` (shown as `/A`):
 *   /A                    dashboard (stats, charts, live)
 *   /A/daily[/<date>]     daily calendar / one day: settings override, leaderboard moderation
 *   /A/players[/<id>]     search / one player: games, ban, reset nickname
 *   /A/challenges[/<code>] lookup / one challenge: leaderboard moderation
 *   /A/rooms              live rooms, close
 *   /A/blocklist          nickname blocklist + checker
 *   /A/reports[/<id>]     player reports: filters, resolve/ignore/reopen, details with the place
 *   /A/audit              audit log
 * Every page view is reported to `/api/hits` (the server flags `/<ADMIN_PATH>*` hits as admin and leaves them out of
 * stats).
 */
import './admin.css';
import { createHitTracker } from '../net/hits';
import { api, errorText, onUnauthorized } from './api';
import { ADMIN_PATH, adminUrl, isAdminPath } from './base';
import { button, h, mount } from './dom';
import type { Page, PageContext } from './page';
import { auditPage } from './pages/audit';
import { blocklistPage } from './pages/blocklist';
import { challengesPage } from './pages/challenges';
import { dailyPage } from './pages/daily';
import { dashboardPage } from './pages/dashboard';
import { playersPage } from './pages/players';
import { refreshReportsNav, reportsPage } from './pages/reports';
import { roomsPage } from './pages/rooms';

interface Route {
  path: string;
  label: string;
  page: Page;
}

const ROUTES: Route[] = [
  { path: '', label: 'Dashboard', page: dashboardPage },
  { path: 'daily', label: 'Daily', page: dailyPage },
  { path: 'players', label: 'Players', page: playersPage },
  { path: 'challenges', label: 'Challenges', page: challengesPage },
  { path: 'rooms', label: 'Rooms', page: roomsPage },
  { path: 'blocklist', label: 'Blocklist', page: blocklistPage },
  { path: 'reports', label: 'Reports', page: reportsPage },
  { path: 'audit', label: 'Audit log', page: auditPage },
];

const root = document.getElementById('admin')!;
const hits = createHitTracker();
let cleanup: (() => void) | void = undefined;
let renderSeq = 0;
let loggedIn = false;
let content: HTMLElement | null = null;
let nav: HTMLElement | null = null;

/** Split `/<ADMIN_PATH>/players/abc` → { section: 'players', params: ['abc'] }. */
export function parseAdminPath(pathname: string): { section: string; params: string[] } {
  const rest = (isAdminPath(pathname) ? pathname.slice(ADMIN_PATH.length + 1) : pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = rest === '' ? [] : rest.split('/').map((p) => decodeURIComponent(p));
  return { section: parts[0] ?? '', params: parts.slice(1) };
}

function navigate(path: string, replace = false): void {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  void render();
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  hits.track(location.pathname);
  if (!loggedIn) return renderLogin();
  if (!content) buildShell();
  void refreshReportsNav();
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  const { section, params } = parseAdminPath(location.pathname);
  const route = ROUTES.find((r) => r.path === section);
  for (const a of nav!.querySelectorAll('a')) {
    a.classList.toggle('active', a.getAttribute('href') === (section ? adminUrl(`/${section}`) : adminUrl()));
  }
  const host = h('div', { class: 'page' });
  mount(content!, host);
  if (!route) {
    mount(host, h('h1', {}, 'Not found'), h('p', {}, h('a', { href: adminUrl(), 'data-link': true }, 'Back to the dashboard')));
    return;
  }
  document.title = `${route.label} — Gothic Guessr Admin`;
  const ctx: PageContext = { root: host, params, navigate, isCurrent: () => seq === renderSeq };
  try {
    cleanup = await route.page(ctx);
    if (seq !== renderSeq && typeof cleanup === 'function') cleanup();
  } catch (err) {
    if (seq !== renderSeq) return;
    mount(host, h('div', { class: 'error-box' }, h('h2', {}, 'Could not load this page'), h('p', {}, errorText(err))));
  }
}

function buildShell(): void {
  nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Admin sections' },
    ...ROUTES.map((r) => h('a', { href: r.path ? adminUrl(`/${r.path}`) : adminUrl(), 'data-link': true }, r.label)),
  );
  content = h('main', { class: 'content' });
  const logout = button(
    'Log out',
    async () => {
      try {
        await api.logout();
      } finally {
        loggedIn = false;
        content = null;
        void render();
      }
    },
    { kind: 'ghost', small: true },
  );
  mount(
    root,
    h(
      'div',
      { class: 'layout' },
      h(
        'aside',
        { class: 'sidebar' },
        h('a', { class: 'brand', href: adminUrl(), 'data-link': true }, h('span', { class: 'brand-title' }, 'Gothic Guessr'), h('span', { class: 'brand-sub' }, 'Admin')),
        nav,
        h('div', { class: 'sidebar-foot' }, h('a', { href: '/', class: 'muted-link' }, '← Back to the game'), logout),
      ),
      content,
    ),
  );
}

function renderLogin(message?: string): void {
  content = null;
  document.title = 'Log in — Gothic Guessr Admin';
  const input = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Admin password', placeholder: 'Password' });
  const error = h('p', { class: 'login-error', role: 'alert' }, message ?? '');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Enter');
  const form = h(
    'form',
    { class: 'login', autocomplete: 'on' },
    h('h1', {}, 'Gothic Guessr'),
    h('p', { class: 'sub' }, 'Administration'),
    input,
    submit,
    error,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      await api.login(input.value);
      loggedIn = true;
      input.value = '';
      void render();
    } catch (err) {
      error.textContent = errorText(err);
      input.select();
    } finally {
      submit.disabled = false;
    }
  });
  mount(root, h('div', { class: 'login-wrap' }, form));
  input.focus();
}

// In-app links: any <a data-link> (and plain links into /<ADMIN_PATH>) navigate without a reload.
document.addEventListener('click', (ev) => {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = (ev.target as Element).closest('a');
  if (!a || a.target || !a.hasAttribute('href')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !isAdminPath(url.pathname)) return;
  ev.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) navigate(url.pathname + url.search);
});
window.addEventListener('popstate', () => void render());

onUnauthorized(() => {
  if (!loggedIn) return;
  loggedIn = false;
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  renderLogin('Your session expired. Please log in again.');
});

async function boot(): Promise<void> {
  try {
    await api.session();
    loggedIn = true;
  } catch {
    loggedIn = false;
  }
  await render();
}

void boot();
