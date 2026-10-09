/**
 * Hono glue shared by route modules: the app environment type, player auth from `Authorization: Bearer <token>`,
 * client IP, JSON body parsing and rate limiting. Errors are thrown as {@link ApiFailure}; app.ts turns them into
 * `{error, message?}` responses.
 */
import type { Context } from 'hono';
import type { ApiError } from '../shared/api';
import { ApiFailure, statusForCode } from './core/errors';
import { clientKey } from './core/ip';
import type { RateLimitName } from './core/ratelimit';
import type { PlayerRecord } from './core/repository';
import type { Services } from './services';

export interface AppEnv {
  Variables: {
    services: Services;
    /** Cached result of the token lookup (undefined = not looked up yet). */
    player: PlayerRecord | null | undefined;
  };
}

export type AppContext = Context<AppEnv>;

export function services(c: AppContext): Services {
  return c.get('services');
}

/** Bearer token of the request, or null. */
export function bearerToken(c: AppContext): string | null {
  const header = c.req.header('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

/** The calling player, or null without/with an unknown token. */
export async function optionalPlayer(c: AppContext): Promise<PlayerRecord | null> {
  const cached = c.get('player');
  if (cached !== undefined) return cached;
  const player = await services(c).players.authenticate(bearerToken(c));
  c.set('player', player);
  return player;
}

/** The calling player; 401 `auth` otherwise. */
export async function requirePlayer(c: AppContext): Promise<PlayerRecord> {
  const player = await optionalPlayer(c);
  if (!player) throw new ApiFailure('auth');
  return player;
}

/**
 * Client key for rate limiting only (never stored), see core/ip.ts: with TRUST_PROXY the LAST X-Forwarded-For entry
 * (the one the proxy appended; earlier entries are client-controlled), otherwise the socket address from
 * @hono/node-server's bindings ('unknown' in `app.request()` tests); IPv6 is reduced to its /64.
 */
export function clientIp(c: AppContext): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return clientKey(c.req.header('x-forwarded-for'), env?.incoming?.socket?.remoteAddress, services(c).config.trustProxy);
}

/** Parsed JSON body; `bad_request` when it is not JSON. */
export async function readJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiFailure('bad_request', 'body must be JSON');
  }
}

/** Take a token from the named limiter or throw `rate_limited` with Retry-After. */
export function rateLimit(c: AppContext, name: RateLimitName, key: string): void {
  const s = services(c);
  const decision = s.limits.check(name, key, s.clock());
  if (!decision.ok) throw new ApiFailure('rate_limited', name, Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
}

/**
 * Throw `rate_limited` when the named bucket is empty, without taking a token: for limits that only count failures
 * (room code misses), checked before the lookup so a hit and a miss look the same once the bucket is empty.
 */
export function requireBudget(c: AppContext, name: RateLimitName, key: string): void {
  const s = services(c);
  const decision = s.limits.peek(name, key, s.clock());
  if (!decision.ok) throw new ApiFailure('rate_limited', name, Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
}

/** Origin for links in share texts: PUBLIC_ORIGIN, else the request's own origin. */
export function publicOrigin(c: AppContext): string {
  const configured = services(c).config.publicOrigin;
  if (configured) return configured;
  const url = new URL(c.req.url);
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  const proto = services(c).config.trustProxy ? (c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')) : url.protocol.replace(':', '');
  return `${proto}://${host}`;
}

/** JSON error response for any thrown value (unknown errors → 500 `internal`, logged). */
export function errorResponse(c: AppContext, err: unknown): Response {
  if (err instanceof ApiFailure) {
    const body: ApiError = { error: err.code };
    if (err.message && err.message !== err.code) body.message = err.message;
    if (err.retryAfterS !== undefined) c.header('Retry-After', String(err.retryAfterS));
    return c.json(body, statusForCode(err.code) as 400);
  }
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'internal' } satisfies ApiError, 500);
}
