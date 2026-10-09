/**
 * The app shell (SPEC §10.7): routes → pages, the shared viewers, games and their reload safety.
 *
 * Every route change destroys the current page and builds the next one. Game pages (`/play`, `/daily`, `/c/<code>`)
 * first look for a running game stored for that path in sessionStorage (src/play/session.ts): when there is one,
 * the game is resumed from `GET /games/:id` (or shown as its summary when finished) instead of the page. Starting a
 * game stores it and re-enters its path, so a reload at any point lands back in the game. Leaving the game's path
 * through the app (menu button, browser back) forgets it; the server keeps the game, and daily/challenge pages
 * offer "Continue".
 */
import type { GameView, PlayerView, PublicSettings } from '../shared/api';
import type { GuessMapWorld, PublicWorlds } from './contracts';
import { loadedSlugs, panoLayout } from './data/worlds';
import { errorMessage, getLanguage, t } from './i18n';
import { isApiError } from './net/api';
import type { ApiClient } from './net/api';
import { createHitTracker } from './net/hits';
import { challengePage } from './pages/challenge';
import type { AppContext, Page, Viewers } from './pages/context';
import { dailyPage } from './pages/daily';
import { menuPage } from './pages/menu';
import { rooms } from './pages/room';
import { setupPage } from './pages/setup';
import { GameFlow } from './play/flow';
import { RestGameSession, clearStoredGame, readStoredGame, writeStoredGame } from './play/session';
import { Router, routePath } from './router';
import type { Route } from './router';
import { toast } from './ui/dom';
import { installReportLink } from './ui/report';
import { Screens } from './ui/screens';

/** True when the page was loaded by a reload (not a link, a typed URL or history navigation). */
function isReload(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === 'reload';
  } catch {
    return false;
  }
}

/** Pathnames on which a game can run. */
function gamePath(route: Route): string | null {
  if (route.name === 'play') return '/play';
  if (route.name === 'daily' && route.date === null) return '/daily';
  if (route.name === 'challenge') return routePath(route);
  return null;
}

export class App implements AppContext {
  readonly api: ApiClient;
  readonly worlds: PublicWorlds;
  readonly slugs: string[];
  readonly screens: Screens;
  readonly router = new Router();
  private page: Page | null = null;
  private viewersPromise: Promise<Viewers> | null = null;
  private currentPlayer: PlayerView | null = null;
  /** A game view just created, handed to the route handler to skip one `GET /games/:id`. */
  private pending: GameView | null = null;

  constructor(root: HTMLElement, api: ApiClient, worlds: PublicWorlds) {
    this.api = api;
    this.worlds = worlds;
    this.slugs = loadedSlugs(worlds);
    this.screens = new Screens(root);
    api.onPlayer((p) => (this.currentPlayer = p));
  }

  start(): void {
    const hits = createHitTracker({ lang: getLanguage });
    installReportLink(this.api, this.router);
    this.router.onChange((route) => hits.track(routePath(route)));
    this.router.start((route, cause) => this.show(route, cause === 'start' && isReload()));
  }

  player(): PlayerView | null {
    return this.currentPlayer;
  }

  viewers(): Promise<Viewers> {
    if (!this.viewersPromise) {
      const layout = panoLayout(this.worlds);
      this.viewersPromise = Promise.all([import('./ui/guessmap'), import('./ui/panorama')]).then(([g, p]) => {
        if (!layout) throw new Error('no world loaded');
        return { map: new g.GuessMap(this.mapWorlds(this.slugs)), panorama: new p.PanoramaView(layout) };
      });
      this.viewersPromise.catch(() => (this.viewersPromise = null));
    }
    return this.viewersPromise;
  }

  /** Start loading the viewer chunk early (while the menu is up). */
  preloadViewers(): void {
    void Promise.all([import('./ui/guessmap'), import('./ui/panorama')]).catch(() => undefined);
  }

  mapWorlds(slugs: readonly string[]): GuessMapWorld[] {
    const out: GuessMapWorld[] = [];
    for (const [slug, w] of this.worlds.worlds) {
      if (slugs.includes(slug)) out.push({ slug, name: w.info.name, map: w.data.map });
    }
    return out;
  }

  openGame(game: GameView, path: string): void {
    writeStoredGame({ id: game.id, path });
    this.pending = game;
    const same = location.pathname === path;
    this.router.navigate(path, { replace: same });
  }

  async startSolo(settings: PublicSettings): Promise<void> {
    try {
      const game = await this.api.createGame({ kind: 'solo', settings });
      this.openGame(game, '/play');
    } catch (err) {
      toast(isApiError(err) ? errorMessage(err.code) : t('error.unknown'));
    }
  }

  // --- routing -----------------------------------------------------------------------------

  /** `reloaded`: this is the first route of a page reload (a finished stored game then shows its summary again). */
  private show(route: Route, reloaded = false): void {
    this.page?.destroy();
    this.page = null;
    const path = gamePath(route);
    const stored = readStoredGame();
    if (stored && stored.path !== path) clearStoredGame();
    if (path && stored && stored.path === path) {
      this.resumeGame(stored.id, route, reloaded);
      return;
    }
    this.pending = null;
    this.page = this.buildPage(route);
  }

  private buildPage(route: Route): Page {
    switch (route.name) {
      case 'menu':
        this.preloadViewers();
        return menuPage(this);
      case 'play':
        this.preloadViewers();
        return setupPage(this);
      case 'daily':
        return dailyPage(this, route.date);
      case 'challenge':
        return challengePage(this, route.code);
      case 'room':
        return rooms.page(this, route.code);
    }
  }

  /**
   * Resume the stored game. A finished one shows its summary only right after it was played or on a reload; a fresh
   * visit of the page (typed URL, link) forgets it and shows the page, which has the result anyway. On failure the
   * game is forgotten and the page is shown instead.
   */
  private resumeGame(id: string, route: Route, reloaded: boolean): void {
    const pending = this.pending?.id === id ? this.pending : null;
    this.pending = null;
    let cancelled = false;
    let flow: GameFlow | null = null;
    const holder: Page = {
      alive: true,
      destroy: () => {
        cancelled = true;
        holder.alive = false;
        flow?.destroy();
      },
    };
    this.page = holder;
    const begin = (view: GameView): void => {
      if (cancelled) return;
      if (view.finished && !reloaded && !pending) {
        clearStoredGame();
        this.page = this.buildPage(route);
        return;
      }
      flow = new GameFlow(this, new RestGameSession(this.api, view));
      void flow.start();
    };
    if (pending) {
      begin(pending);
      return;
    }
    this.screens.showMessage({ text: () => t('menu.loading') });
    this.api
      .getGame(id)
      .then(begin)
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('Could not resume the stored game', err);
        clearStoredGame();
        this.page = this.buildPage(route);
      });
  }
}
