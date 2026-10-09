/**
 * Public site settings: `GET /config` → {@link PublicConfigView} (no auth, no player needed). Today only the optional
 * contact of the legal notice (PUBLIC_CONTACT, server/config.ts); null when it is not configured.
 */
import { Hono } from 'hono';
import type { PublicConfigView } from '../../shared/api';
import { services } from '../http';
import type { AppEnv } from '../http';

export function configRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/config', (c) => {
    const view: PublicConfigView = { contact: services(c).config.publicContact ?? null };
    return c.json(view);
  });
  return r;
}
