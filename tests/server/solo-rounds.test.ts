/**
 * Quick play round counts (owner request, 2026-10-08): a solo game may have 3, 5 or 10 rounds (default 5), a challenge
 * created by it inherits the count, the daily stays at 5.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicSettings } from '../../shared/api';
import { ROUND_COUNTS } from '../../shared/api';
import { ApiFailure } from '../../server/core/errors';
import { parseSettings, SOLO_ROUND_CHOICES } from '../../server/core/settings';
import { harness } from './helpers';
import type { Harness } from './helpers';

const all = ['alpha', 'beta'];
const base = { mode: 'hardcore', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0 };

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiFailure) return err.code;
    throw err;
  }
  return 'ok';
}

describe('parseSettings: solo rounds', () => {
  it('accepts 3, 5 and 10 and defaults to 5', () => {
    expect(SOLO_ROUND_CHOICES).toEqual([3, 5, 10]);
    expect(ROUND_COUNTS).toEqual([3, 5, 10]);
    for (const rounds of [3, 5, 10]) expect(parseSettings({ ...base, rounds }, all, 'solo').rounds).toBe(rounds);
    expect(parseSettings(base, all, 'solo').rounds).toBe(5);
    expect(parseSettings(base, all).rounds).toBe(5);
  });

  it('rejects any other count with bad_request', () => {
    for (const rounds of [0, 1, 4, 7, 30, 99, -5, 5.5, '5', null, true]) {
      expect(failure(() => parseSettings({ ...base, rounds }, all, 'solo')), JSON.stringify(rounds)).toBe('bad_request');
    }
  });

  it('keeps the daily at 5 whatever is asked', () => {
    for (const rounds of [3, 10, 99, undefined]) expect(parseSettings({ ...base, rounds }, all, 'daily').rounds).toBe(5);
  });
});

describe('solo games with a round count', () => {
  let h: Harness;
  let pid: string;
  let pid2: string;
  beforeEach(async () => {
    h = harness();
    pid = (await h.services.players.create()).player.id;
    pid2 = (await h.services.players.create()).player.id;
  });
  afterEach(() => h.close());

  async function playThrough(gameId: string, player: string): Promise<number> {
    let played = 0;
    for (;;) {
      const view = await h.services.games.getGame(gameId, player);
      if (view.finished) return played;
      await h.services.games.openRound(gameId, player);
      await h.services.games.guess(gameId, player, null);
      played++;
      if (played > 20) throw new Error('runaway game');
    }
  }

  it.each([3, 5, 10])('%i rounds: the game, its challenge and the summary agree', async (rounds) => {
    const settings: PublicSettings = { ...(base as Omit<PublicSettings, 'rounds'>), mode: 'hardcore', rounds };
    const game = await h.services.games.createSolo(pid, settings);
    expect(game.totalRounds).toBe(rounds);
    expect(game.settings.rounds).toBe(rounds);
    expect(await playThrough(game.id, pid)).toBe(rounds);
    const summary = await h.services.games.summary(game.id, pid, 'http://localhost');
    expect(summary.game.results).toHaveLength(rounds);

    const challenge = await h.services.games.challengeView(game.challengeCode, pid2);
    expect(challenge.settings.rounds).toBe(rounds);
    // A friend opening the challenge link plays the same number of rounds.
    const friend = await h.services.games.joinChallenge(pid2, game.challengeCode);
    expect(friend.totalRounds).toBe(rounds);
    expect(await playThrough(friend.id, pid2)).toBe(rounds);
  });

  it('refuses a solo game with an unsupported count', async () => {
    await expect(h.services.games.createSolo(pid, { ...base, rounds: 7 })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('the daily keeps 5 rounds', async () => {
    const daily = await h.services.games.joinDaily(pid);
    expect(daily.totalRounds).toBe(5);
  });
});

describe('POST /api/games with rounds', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.close());

  it('creates a 3-round solo game over HTTP and rejects 4', async () => {
    const created = await h.app.request('/api/players', { method: 'POST' });
    const { token } = (await created.json()) as { token: string };
    const post = async (rounds: number): Promise<Response> =>
      h.app.request('/api/games', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'solo', settings: { ...base, rounds } }),
      });
    const ok = await post(3);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { totalRounds: number }).totalRounds).toBe(3);
    const bad = await post(4);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'bad_request' });
  });
});
