/**
 * Client routes (SPEC §10.2) on the History API:
 *
 *   /                  main menu
 *   /play              solo setup (and the solo game it starts)
 *   /daily             today's daily challenge
 *   /daily/YYYY-MM-DD  a past day (view only)
 *   /c/<code>          a challenge link
 *   /r/<CODE>          a room (party/duel) — rendered by the rooms module (src/pages/room.ts)
 *
 * Anything else (and stage-2 `?seed=` links) lands on the main menu; the URL is rewritten to `/`. Query strings
 * are dropped from the routes above. `parseRoute`/`routePath` are pure; {@link Router} wires them to
 * `history` and `popstate` and notifies one handler per change.
 */

export type Route =
  | { name: 'menu' }
  | { name: 'play' }
  | { name: 'daily'; date: string | null }
  | { name: 'challenge'; code: string }
  | { name: 'room'; code: string };

export type RouteName = Route['name'];

const CHALLENGE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const ROOM_CODE = /^[A-Za-z0-9]{1,16}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The route of a pathname, or null when unknown. Trailing slashes are ignored. */
export function parseRoute(pathname: string): Route | null {
  let path = pathname.split(/[?#]/)[0] ?? '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (path === '' || path === '/') return { name: 'menu' };
  if (path === '/play') return { name: 'play' };
  if (path === '/daily') return { name: 'daily', date: null };
  const parts = path.split('/').slice(1).map(safeDecode);
  if (parts.length !== 2 || parts[1] === null) return null;
  const [head, arg] = parts as [string, string];
  if (head === 'daily' && ISO_DATE.test(arg)) return { name: 'daily', date: arg };
  if (head === 'c' && CHALLENGE_CODE.test(arg)) return { name: 'challenge', code: arg };
  if (head === 'r' && ROOM_CODE.test(arg)) return { name: 'room', code: arg.toUpperCase() };
  return null;
}

/** The canonical pathname of a route. */
export function routePath(route: Route): string {
  switch (route.name) {
    case 'menu':
      return '/';
    case 'play':
      return '/play';
    case 'daily':
      return route.date ? `/daily/${route.date}` : '/daily';
    case 'challenge':
      return `/c/${encodeURIComponent(route.code)}`;
    case 'room':
      return `/r/${encodeURIComponent(route.code.toUpperCase())}`;
  }
}

/** True when both routes name the same page. */
export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b);
}

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one. */
  replace?: boolean;
}

/** Why the handler runs: the first render, an in-app navigation, or browser back/forward. */
export type RouteCause = 'start' | 'navigate' | 'popstate';

export type RouteHandler = (route: Route, cause: RouteCause) => void;

export class Router {
  private handler: RouteHandler | null = null;
  private current: Route = { name: 'menu' };
  private readonly listeners = new Set<(route: Route) => void>();
  private readonly onPop = (): void => this.dispatch(this.resolve(location.pathname, true), 'popstate');

  /** Install the handler, read the current URL and render it. Call once. */
  start(handler: RouteHandler): void {
    this.handler = handler;
    window.addEventListener('popstate', this.onPop);
    this.dispatch(this.resolve(location.pathname + location.search, true), 'start');
  }

  /** The route on screen. */
  get route(): Route {
    return this.current;
  }

  /** Go to `target` (a route or a pathname). Same page + `replace` only rewrites the URL. */
  navigate(target: Route | string, options: NavigateOptions = {}): void {
    const route = typeof target === 'string' ? (parseRoute(target) ?? { name: 'menu' }) : target;
    const path = routePath(route);
    if (options.replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    this.dispatch(route, 'navigate');
  }

  /** Subscribe to every route change (after the handler); returns an unsubscribe function. */
  onChange(fn: (route: Route) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    window.removeEventListener('popstate', this.onPop);
    this.handler = null;
    this.listeners.clear();
  }

  /** Parse `url`; unknown paths and leftover queries are normalised in the address bar (replace). */
  private resolve(url: string, fixUrl: boolean): Route {
    const route = parseRoute(url) ?? { name: 'menu' as const };
    const canonical = routePath(route);
    if (fixUrl && location.pathname + location.search + location.hash !== canonical) {
      history.replaceState(null, '', canonical);
    }
    return route;
  }

  private dispatch(route: Route, cause: RouteCause): void {
    this.current = route;
    this.handler?.(route, cause);
    for (const fn of [...this.listeners]) fn(route);
  }
}
