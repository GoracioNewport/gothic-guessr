/**
 * What every page and the game flow get from the app (src/app.ts): the API client, the public world data, the
 * screen shell, the router and the lazily created viewers. Pages are plain functions `(ctx, …) => Page`; the app
 * destroys the current page on every route change, so a page checks `page.alive` after each `await` before it
 * touches the screen.
 */
import type { GameView, PlayerView, PublicSettings } from '../../shared/api';
import type { GuessMapWorld, PublicWorlds } from '../contracts';
import type { ApiClient } from '../net/api';
import type { Router } from '../router';
import type { GuessMap } from '../ui/guessmap';
import type { PanoramaView } from '../ui/panorama';
import type { Screens } from '../ui/screens';

/** The two viewers, created once (lazy chunk) and reused by every game. */
export interface Viewers {
  panorama: PanoramaView;
  map: GuessMap;
}

export interface AppContext {
  readonly api: ApiClient;
  readonly worlds: PublicWorlds;
  /** Slugs of the loaded worlds, in worlds.json order. */
  readonly slugs: string[];
  readonly screens: Screens;
  readonly router: Router;
  /** The current player once known (after the menu or any player call). */
  player(): PlayerView | null;
  /** The viewers, loading their chunk on first use. */
  viewers(): Promise<Viewers>;
  /** Guess-map tabs for `slugs` (loaded worlds only, worlds.json order). */
  mapWorlds(slugs: readonly string[]): GuessMapWorld[];
  /** Play (or resume, or show the summary of) `game` on page `path` (`/play`, `/daily`, `/c/<code>`). */
  openGame(game: GameView, path: string): void;
  /** Create a solo game with `settings` and play it on `/play`. Errors are shown as a toast. */
  startSolo(settings: PublicSettings): Promise<void>;
}

/** A mounted page. `alive` turns false when the app moves on. */
export interface Page {
  alive: boolean;
  destroy(): void;
}

/** A page handle whose destroy only flips `alive` (plus optional extra teardown). */
export function pageScope(teardown?: () => void): Page {
  const page: Page = {
    alive: true,
    destroy() {
      if (!page.alive) return;
      page.alive = false;
      teardown?.();
    },
  };
  return page;
}
