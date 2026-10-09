/**
 * Games (SPEC §10.4): create/resume, rounds, node lookups with the reach check, guesses, summary.
 *
 *   POST /games {kind:'solo', settings} | {kind:'challenge', code} | {kind:'daily'}   → GameView (201 solo, 200 else)
 *                                      new solo games: 20 per 10 min per player
 *   GET  /games/:id                    → GameView
 *   POST /games/:id/rounds             → RoundView
 *   GET  /games/:id/nodes/:key         → PanoNode     (10/s per player, across all of the player's games)
 *   POST /games/:id/guess {guess}      → RoundResultView   (2/s per player)
 *   GET  /games/:id/summary            → GameSummaryView
 */
import { Hono } from 'hono';
import type { GameSummaryView, GameView, PanoNode, RoundResultView, RoundView } from '../../shared/api';
import { ApiFailure } from '../core/errors';
import { publicOrigin, rateLimit, readJson, requirePlayer, services } from '../http';
import type { AppEnv } from '../http';

export function gamesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post('/games', async (c) => {
    const player = await requirePlayer(c);
    const body = (await readJson(c)) as Record<string, unknown> | null;
    const games = services(c).games;
    if (!body || typeof body !== 'object') throw new ApiFailure('bad_request', 'body');
    let view: GameView;
    switch (body.kind) {
      case 'solo':
        rateLimit(c, 'createSolo', `player:${player.id}`);
        return c.json((await games.createSolo(player.id, body.settings)) satisfies GameView, 201);
      case 'challenge':
        if (typeof body.code !== 'string' || body.code.length > 64) throw new ApiFailure('bad_request', 'code');
        view = await games.joinChallenge(player.id, body.code);
        break;
      case 'daily':
        view = await games.joinDaily(player.id);
        break;
      default:
        throw new ApiFailure('bad_request', 'kind');
    }
    return c.json(view satisfies GameView);
  });

  r.get('/games/:id', async (c) => {
    const player = await requirePlayer(c);
    return c.json((await services(c).games.getGame(c.req.param('id'), player.id)) satisfies GameView);
  });

  r.post('/games/:id/rounds', async (c) => {
    const player = await requirePlayer(c);
    return c.json((await services(c).games.openRound(c.req.param('id'), player.id)) satisfies RoundView);
  });

  r.get('/games/:id/nodes/:key', async (c) => {
    const player = await requirePlayer(c);
    const id = c.req.param('id');
    rateLimit(c, 'nodeLookup', `player:${player.id}`);
    return c.json((await services(c).games.getNode(id, player.id, c.req.param('key'))) satisfies PanoNode);
  });

  r.post('/games/:id/guess', async (c) => {
    const player = await requirePlayer(c);
    rateLimit(c, 'guess', `player:${player.id}`);
    const body = (await readJson(c)) as { guess?: unknown } | null;
    if (!body || typeof body !== 'object' || !('guess' in body)) throw new ApiFailure('bad_request', 'guess');
    return c.json((await services(c).games.guess(c.req.param('id'), player.id, body.guess)) satisfies RoundResultView);
  });

  r.get('/games/:id/summary', async (c) => {
    const player = await requirePlayer(c);
    const view = await services(c).games.summary(c.req.param('id'), player.id, publicOrigin(c));
    return c.json(view satisfies GameSummaryView);
  });

  return r;
}
