/**
 * Challenges and leaderboards (SPEC §10.4). The token is optional: without it `myGame`/`me` are null.
 *
 *   GET /challenges/:code                       → ChallengeView
 *   GET /challenges/:code/leaderboard?limit=50  → LeaderboardView
 */
import { Hono } from 'hono';
import type { ChallengeView, LeaderboardView } from '../../shared/api';
import { optionalPlayer, services } from '../http';
import type { AppEnv } from '../http';

export function challengesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/challenges/:code', async (c) => {
    const player = await optionalPlayer(c);
    return c.json((await services(c).games.challengeView(c.req.param('code'), player?.id ?? null)) satisfies ChallengeView);
  });

  r.get('/challenges/:code/leaderboard', async (c) => {
    const player = await optionalPlayer(c);
    const limit = Number(c.req.query('limit') ?? 50);
    const view = await services(c).games.leaderboard(c.req.param('code'), player?.id ?? null, limit);
    return c.json(view satisfies LeaderboardView);
  });

  return r;
}
