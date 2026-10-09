/**
 * Analytics (SPEC §10.4): `POST /hits {path, referrer, visitor, lang?}` → 204, 60/min per IP. No IP is stored.
 */
import { Hono } from 'hono';
import { normaliseHit } from '../core/analytics';
import { clientIp, rateLimit, readJson, services } from '../http';
import type { AppEnv } from '../http';

export function hitsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/hits', async (c) => {
    rateLimit(c, 'hits', `ip:${clientIp(c)}`);
    const s = services(c);
    const ownHost = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? null;
    await s.repo.insertHit(normaliseHit(await readJson(c), s.clock(), ownHost, s.config.adminPath));
    return c.body(null, 204);
  });

  return r;
}
