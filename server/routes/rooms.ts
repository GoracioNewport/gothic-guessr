/**
 * Rooms over REST (SPEC §10.6); the live part runs over the WebSocket hub (server/rooms/).
 *
 *   POST /rooms {type:'party'|'duel', settings} → 201 {code}   creator = host; banned → 403 `banned`;
 *        party without `timeLimit` gets 120 s; 10 rooms per 10 min per player and 20 per 30 min per IP (`rate_limited`)
 *   GET  /rooms/:code                          → RoomView      404 when unknown or expired; `myGameId` for the caller.
 *        Unknown codes count against `roomMiss` (30 per 10 min per IP, shared with WebSocket joins); once it is spent
 *        every lookup gets 429, hit or miss, so codes cannot be enumerated.
 */
import { Hono } from 'hono';
import type { CreateRoomResponse, RoomView } from '../../shared/api';
import { ApiFailure } from '../core/errors';
import { clientIp, optionalPlayer, readJson, requireBudget, requirePlayer, services } from '../http';
import type { AppEnv } from '../http';
import { roomRegistryOf } from '../rooms/runtime';

export function roomsRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/rooms', async (c) => {
    const player = await requirePlayer(c);
    if (player.banned) throw new ApiFailure('banned');
    const body = (await readJson(c)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiFailure('bad_request', 'body');
    const code = await roomRegistryOf(services(c)).create(player, body.type, body.settings, clientIp(c));
    return c.json({ code } satisfies CreateRoomResponse, 201);
  });

  r.get('/rooms/:code', async (c) => {
    const ipKey = `ip:${clientIp(c)}`;
    requireBudget(c, 'roomMiss', ipKey);
    const player = await optionalPlayer(c);
    const view = roomRegistryOf(services(c)).view(c.req.param('code'), player?.id ?? null);
    if (!view) {
      const s = services(c);
      s.limits.check('roomMiss', ipKey, s.clock());
      throw new ApiFailure('not_found', 'room');
    }
    return c.json(view satisfies RoomView);
  });

  return r;
}
