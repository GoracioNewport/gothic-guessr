/**
 * Daily challenge (SPEC §10.4, §10.5). Token optional.
 *
 *   GET /daily        → today's ChallengeView (created lazily)
 *   GET /daily/:date  → that day's ChallengeView (YYYY-MM-DD; today, or a past day that was played; else 404)
 *
 * The leaderboard of a day is `GET /challenges/<view.code>/leaderboard`.
 */
import { Hono } from 'hono';
import type { ChallengeView } from '../../shared/api';
import { optionalPlayer, services } from '../http';
import type { AppEnv } from '../http';

export function dailyRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/daily', async (c) => {
    const player = await optionalPlayer(c);
    return c.json((await services(c).games.dailyView(null, player?.id ?? null)) satisfies ChallengeView);
  });

  r.get('/daily/:date', async (c) => {
    const player = await optionalPlayer(c);
    return c.json((await services(c).games.dailyView(c.req.param('date'), player?.id ?? null)) satisfies ChallengeView);
  });

  return r;
}
