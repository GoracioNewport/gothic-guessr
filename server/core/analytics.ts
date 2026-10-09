/**
 * Page-view analytics (SPEC §10.4 `POST /hits`, §10.10 dashboard). Pure normalisation of the client's report into a
 * {@link HitRecord}: the path without query/fragment, only the referrer's host (empty for same-site and direct
 * visits), a validated visitor id. IPs are never part of it.
 */
import { LANGS } from '../../shared/api';
import type { Lang } from '../../shared/api';
import { ApiFailure } from './errors';
import type { HitRecord } from './repository';
import { utcDate } from './settings';

const MAX_PATH = 256;

/**
 * Validate a hit. `ownHost` (the site's host, e.g. `localhost:5173`) turns same-site referrers into ''. Paths under
 * `/<adminPath>` (config ADMIN_PATH) are flagged `admin` and left out of the public stats.
 * Throws `bad_request`.
 */
export function normaliseHit(raw: unknown, now: number, ownHost: string | null, adminPath = 'admin'): HitRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ApiFailure('bad_request', 'hit');
  const h = raw as Record<string, unknown>;
  if (typeof h.path !== 'string' || !h.path.startsWith('/')) throw new ApiFailure('bad_request', 'path');
  if (typeof h.visitor !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(h.visitor)) throw new ApiFailure('bad_request', 'visitor');
  if (h.referrer !== undefined && typeof h.referrer !== 'string') throw new ApiFailure('bad_request', 'referrer');
  if (h.lang !== undefined && h.lang !== null && !LANGS.includes(h.lang as Lang)) throw new ApiFailure('bad_request', 'lang');
  const path = (h.path.split(/[?#]/)[0] ?? '/').slice(0, MAX_PATH) || '/';
  return {
    at: now,
    day: utcDate(now),
    path,
    referrerHost: referrerHost((h.referrer as string | undefined) ?? '', ownHost),
    visitor: h.visitor,
    lang: (h.lang as Lang | undefined) ?? null,
    admin: path === `/${adminPath}` || path.startsWith(`/${adminPath}/`),
  };
}

/** Lowercased host of a referrer URL; '' when empty, unparsable, not http(s) or the site itself. */
export function referrerHost(referrer: string, ownHost: string | null): string {
  if (!referrer) return '';
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.host.toLowerCase();
    if (ownHost && host === ownHost.toLowerCase()) return '';
    return host.slice(0, 253);
  } catch {
    return '';
  }
}
