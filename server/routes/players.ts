/**
 * Players (SPEC §10.4): `POST /players {lang?}` → {token, player} (10/h per IP), `GET /me`, `PATCH /me {nickname}`.
 */
import { Hono } from 'hono';
import { LANGS } from '../../shared/api';
import type { CreatePlayerRequest, CreatePlayerResponse, Lang, PlayerView } from '../../shared/api';
import { playerView } from '../core/players';
import { clientIp, rateLimit, readJson, requirePlayer, services } from '../http';
import type { AppEnv } from '../http';

export function playersRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/players', async (c) => {
    rateLimit(c, 'createPlayer', `ip:${clientIp(c)}`);
    // The body is optional ({lang} picks the language of the default nickname); anything unexpected falls back to English.
    const body = (await readJson(c).catch(() => null)) as CreatePlayerRequest | null;
    const lang = LANGS.includes(body?.lang as Lang) ? (body?.lang as Lang) : undefined;
    const { token, player } = await services(c).players.create(lang);
    return c.json({ token, player: playerView(player) } satisfies CreatePlayerResponse, 201);
  });

  r.get('/me', async (c) => {
    const player = await requirePlayer(c);
    return c.json(playerView(player) satisfies PlayerView);
  });

  r.patch('/me', async (c) => {
    const player = await requirePlayer(c);
    const body = (await readJson(c)) as { nickname?: unknown } | null;
    const updated = await services(c).players.rename(player, body?.nickname);
    return c.json(playerView(updated) satisfies PlayerView);
  });

  return r;
}
