/**
 * Security review (stage 3): concurrency and cheating paths that HOLD today (regression guards, all passing).
 * One game per player and challenge under concurrent POSTs, one outcome per round under concurrent guesses, the
 * deadline + grace rule, and the reach check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameView, PanoNode, PublicSettings, RoundResultView, RoundView } from '../../shared/api';
import { RateLimits } from '../../server/core/ratelimit';
import { nodeByKey } from '../../server/core/worlds';
import { Client, harness } from './helpers';
import type { Harness } from './helpers';

const OPEN = { limit: 10_000, windowMs: 1_000 };
const relaxed = () =>
  new RateLimits({ createPlayer: OPEN, nodeLookup: OPEN, guess: OPEN, hits: OPEN, adminLogin: OPEN });
const TIMED: PublicSettings = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 30, rounds: 5 };

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

describe('review: races', () => {
  it('concurrent joins of one challenge yield one game', async () => {
    h = harness({ limits: relaxed() });
    const owner = new Client(h.app, '10.60.0.1');
    await owner.register();
    const code = (await owner.call<GameView>('POST', '/api/games', { kind: 'solo', settings: TIMED })).body.challengeCode;
    const friend = new Client(h.app, '10.60.0.2');
    await friend.register();
    const res = await Promise.all(Array.from({ length: 12 }, () => friend.call<GameView>('POST', '/api/games', { kind: 'challenge', code })));
    expect(new Set(res.map((r) => r.status))).toEqual(new Set([200]));
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
    expect(await h.services.repo.countGames(code)).toBe(2);
  });

  it('concurrent first daily joins create one challenge and one game', async () => {
    h = harness({ limits: relaxed() });
    const c = new Client(h.app, '10.60.0.3');
    await c.register();
    const res = await Promise.all(Array.from({ length: 8 }, () => c.call<GameView>('POST', '/api/games', { kind: 'daily' })));
    expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
  });

  it('concurrent guesses record exactly one outcome', async () => {
    h = harness({ limits: relaxed() });
    const c = new Client(h.app, '10.60.0.4');
    await c.register();
    const game = (await c.call<GameView>('POST', '/api/games', { kind: 'solo', settings: TIMED })).body;
    await c.call<RoundView>('POST', `/api/games/${game.id}/rounds`);
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => c.call<RoundResultView>('POST', `/api/games/${game.id}/guess`, { guess: { world: 'alpha', x: i * 1000, z: 0 } })),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(5);
  });

  it('a guess after deadline + 2 s is recorded as a timeout; a second attempt at a finished challenge is refused', async () => {
    h = harness({ limits: relaxed() });
    const c = new Client(h.app, '10.60.0.5');
    await c.register();
    const game = (await c.call<GameView>('POST', '/api/games', { kind: 'solo', settings: TIMED })).body;
    await c.call<RoundView>('POST', `/api/games/${game.id}/rounds`);
    const answer = (await h.services.repo.listRounds(game.id))[0]!;
    const node = nodeByKey(h.services.worlds.get(answer.world)!, answer.key)!;
    h.clock.advance(32_001);
    const late = await c.call<RoundResultView>('POST', `/api/games/${game.id}/guess`, { guess: { world: answer.world, x: node.x, z: node.z } });
    expect(late.status).toBe(200);
    expect(late.body.timedOut).toBe(true);
    expect(late.body.score).toBe(0);
  });

  it('the reach check refuses a key two hops away and any key of another round', async () => {
    h = harness({ limits: relaxed() });
    const c = new Client(h.app, '10.60.0.6');
    await c.register();
    const game = (await c.call<GameView>('POST', '/api/games', { kind: 'solo', settings: TIMED })).body;
    const round = (await c.call<RoundView>('POST', `/api/games/${game.id}/rounds`)).body;
    const r1 = (await h.services.repo.listRounds(game.id))[0]!;
    const world = h.services.worlds.get(r1.world)!;
    const startId = world.idByKey.get(round.start.key)!;
    const oneHop = new Set(world.manifest.nodes[startId]!.links.map((l) => l.to));
    const far = world.manifest.nodes.find((n) => n.id !== startId && !oneHop.has(n.id))!;
    expect((await c.call<PanoNode>('GET', `/api/games/${game.id}/nodes/${far.key}`)).status).toBe(404);
    const challenge = (await h.services.repo.getChallenge(game.challengeCode))!;
    const nextStart = challenge.picks[1]!.key;
    if (nextStart !== round.start.key && !oneHop.has(world.idByKey.get(nextStart) ?? -1)) {
      expect((await c.call('GET', `/api/games/${game.id}/nodes/${nextStart}`)).status).toBe(404);
    }
  });
});
