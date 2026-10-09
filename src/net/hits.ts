/**
 * Page-view analytics (SPEC §10.4): `POST /api/hits {path, referrer, visitor, lang}` on every client route change.
 * `visitor` is a random id kept in `localStorage['gothic2guessr.visitor']` (not the player token). The external
 * referrer (`document.referrer`) is sent with the first hit of the page only; later in-app navigations send ''.
 * Fire-and-forget: failures are ignored, nothing waits for it.
 */
import type { HitRequest, Lang } from '../../shared/api';

export const VISITOR_KEY = 'gothic2guessr.visitor';

/** A random URL-safe id (`[A-Za-z0-9_-]{22}`). */
export function randomVisitorId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The stored visitor id, created on first use. Without storage a per-page id is used. */
export function visitorId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string {
  try {
    const stored = storage?.getItem(VISITOR_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  } catch {
    /* fall through */
  }
  const id = pageVisitor ?? randomVisitorId();
  pageVisitor = id;
  try {
    storage?.setItem(VISITOR_KEY, id);
  } catch {
    /* per-page id */
  }
  return id;
}

let pageVisitor: string | null = null;

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface HitTracker {
  /** Report a view of `path` (pathname only). */
  track(path: string): void;
}

/**
 * A tracker posting to `<apiBase>/hits`. `send` is injectable for tests; by default `fetch` with `keepalive`
 * so the last hit before leaving the page is not lost.
 */
export function createHitTracker(opts: {
  apiBase?: string;
  lang?: () => Lang;
  referrer?: string;
  send?: (url: string, body: HitRequest) => void;
} = {}): HitTracker {
  const url = `${(opts.apiBase ?? '/api').replace(/\/+$/, '')}/hits`;
  let referrer = opts.referrer ?? (typeof document !== 'undefined' ? document.referrer : '');
  let last: string | null = null;
  const send =
    opts.send ??
    ((target: string, body: HitRequest) => {
      void fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => undefined);
    });
  return {
    track(path: string): void {
      const clean = path.split(/[?#]/)[0] || '/';
      if (clean === last) return; // replaceState of the same page is not a new view
      last = clean;
      const body: HitRequest = { path: clean, referrer, visitor: visitorId() };
      if (opts.lang) body.lang = opts.lang();
      referrer = '';
      try {
        send(url, body);
      } catch {
        /* analytics never break the game */
      }
    },
  };
}
