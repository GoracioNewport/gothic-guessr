import { describe, expect, it } from 'vitest';
import type { GameView, RoundResultView, RoundView } from '../shared/api';
import type { ApiClient } from '../src/net/api';
import { RestGameSession, STORED_GAME_KEY, clearStoredGame, readStoredGame, writeStoredGame } from '../src/play/session';

const settings = { mode: 'mixed' as const, worlds: ['khorinis'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

function view(over: Partial<GameView> = {}): GameView {
  return {
    id: 'g1', kind: 'solo', challengeCode: 'c1', settings, totalRounds: 2, results: [], current: null, currentKey: null,
    finished: false, total: 0, ...over,
  };
}

const round = (n: number): RoundView => ({ n, start: { key: `start${n}`, links: [] }, deadline: null, startedAt: 0 });
const result = (n: number, score: number): RoundResultView => ({
  n, guess: { world: 'khorinis', x: 0, z: 0 }, answer: { world: 'khorinis', x: 1, z: 1 }, distanceM: 1, score, timeMs: 10, timedOut: false,
});

function fakeApi(): { api: ApiClient; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const api = {
    openRound: async (id: string) => {
      calls.push(`round ${id}`);
      return round(++n);
    },
    getNode: async (id: string, key: string) => {
      calls.push(`node ${id} ${key}`);
      return { key, links: [] };
    },
    guess: async (id: string, g: unknown) => {
      calls.push(`guess ${id} ${g === null ? 'null' : 'pin'}`);
      return result(n, 1000 * n);
    },
    getGame: async (id: string) => {
      calls.push(`get ${id}`);
      return view({ results: [result(1, 1000)], total: 1000 });
    },
    summary: async (id: string) => {
      calls.push(`summary ${id}`);
      return { game: view(), leaderboard: { code: 'c1', entries: [], me: null, total: 0 } };
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('RestGameSession', () => {
  it('drives rounds over REST and keeps the view in sync', async () => {
    const { api, calls } = fakeApi();
    const s = new RestGameSession(api, view());
    const r1 = await s.nextRound();
    expect(r1.n).toBe(1);
    expect(s.view.current?.n).toBe(1);
    expect(await s.nextRound()).toBe(r1); // open round is returned, not reopened
    await s.node('start1');
    await s.guess({ world: 'khorinis', x: 1, z: 2 });
    expect(s.view.results.map((r) => r.n)).toEqual([1]);
    expect(s.view.total).toBe(1000);
    expect(s.view.current).toBeNull();
    expect(s.view.finished).toBe(false);
    await s.nextRound();
    await s.guess(null);
    expect(s.view.finished).toBe(true);
    expect(s.view.total).toBe(3000);
    expect(calls).toEqual(['round g1', 'node g1 start1', 'guess g1 pin', 'round g1', 'guess g1 null']);
  });

  it('resumes an open round without opening another', async () => {
    const { api, calls } = fakeApi();
    const s = new RestGameSession(api, view({ current: round(1), currentKey: 'abc' }));
    expect((await s.nextRound()).n).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refresh replaces the view', async () => {
    const { api } = fakeApi();
    const s = new RestGameSession(api, view());
    await s.refresh();
    expect(s.view.total).toBe(1000);
  });
});

describe('stored game (reload safety)', () => {
  it('round-trips through session storage and ignores garbage', () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    expect(readStoredGame(store)).toBeNull();
    writeStoredGame({ id: 'g1', path: '/play' }, store);
    expect(readStoredGame(store)).toEqual({ id: 'g1', path: '/play' });
    data.set(STORED_GAME_KEY, '{bad json');
    expect(readStoredGame(store)).toBeNull();
    data.set(STORED_GAME_KEY, JSON.stringify({ id: 3 }));
    expect(readStoredGame(store)).toBeNull();
    clearStoredGame(store);
    expect(data.size).toBe(0);
    expect(readStoredGame(null)).toBeNull();
  });
});
