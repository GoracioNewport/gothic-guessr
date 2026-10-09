/**
 * Game engine (server/core/games.ts) over the SQLite repository with the fixture worlds and an injected clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameView, PublicSettings, RoundView } from '../../shared/api';
import { scoreForGuess } from '../../src/game/scoring';
import { ApiFailure } from '../../server/core/errors';
import type { GuessEvent } from '../../server/core/games';
import { DEADLINE_GRACE_MS } from '../../server/core/settings';
import { nodeByKey } from '../../server/core/worlds';
import { harness } from './helpers';
import type { Harness } from './helpers';

const SOLO: PublicSettings = { mode: 'hardcore', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 0, rounds: 5 };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiFailure) return err.code;
    throw err;
  }
  return 'ok';
}

let h: Harness;
let pid: string;
let pid2: string;

beforeEach(async () => {
  h = harness();
  pid = (await h.services.players.create()).player.id;
  pid2 = (await h.services.players.create()).player.id;
});
afterEach(() => h.close());

/** The answer node of an open round (test-only peek into the private manifest). */
function answerOf(round: RoundView): { world: string; x: number; z: number } {
  for (const w of h.services.worlds.values()) {
    const node = nodeByKey(w, round.start.key);
    if (node) return { world: w.slug, x: node.x, z: node.z };
  }
  throw new Error('start key not found');
}

describe('solo games', () => {
  it('creates a challenge + game and never leaks coordinates before the guess', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    expect(game).toMatchObject({ kind: 'solo', totalRounds: 5, finished: false, total: 0, current: null, results: [] });
    expect(game.challengeCode).toMatch(/^[a-z2-9]{8}$/);
    const round = await h.services.games.openRound(game.id, pid);
    const json = JSON.stringify({ game, round });
    expect(json).not.toMatch(/"(x|z|wp|seed|world|dist)"\s*:/);
    expect(round).toMatchObject({ n: 1, deadline: null, startedAt: h.clock.now });
    expect(round.start.links.length).toBeGreaterThan(0);
  });

  it('openRound is idempotent while a round is open', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    const a = await h.services.games.openRound(game.id, pid);
    h.clock.advance(5000);
    const b = await h.services.games.openRound(game.id, pid);
    expect(b).toEqual(a);
  });

  it('scores a guess with src/game/scoring and plays 5 rounds to the end', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    let total = 0;
    const events: GuessEvent[] = [];
    h.services.events.on('guess', (e) => events.push(e));
    for (let n = 1; n <= 5; n++) {
      const round = await h.services.games.openRound(game.id, pid);
      expect(round.n).toBe(n);
      const answer = answerOf(round);
      h.clock.advance(1000 * n);
      const guess = { world: answer.world, x: answer.x + 5000 * n, z: answer.z };
      const result = await h.services.games.guess(game.id, pid, guess);
      const world = h.services.worlds.get(answer.world)!;
      const expected = scoreForGuess(guess, { world: answer.world, nodeId: nodeByKey(world, round.start.key)!.id }, world.manifest);
      expect(result).toEqual({
        n,
        guess,
        answer,
        distanceM: 50 * n,
        score: expected.score,
        timeMs: 1000 * n,
        timedOut: false,
      });
      total += result.score;
      expect(await code(h.services.games.guess(game.id, pid, guess))).toBe('round_over');
    }
    const view = await h.services.games.getGame(game.id, pid);
    expect(view).toMatchObject({ finished: true, total, current: null });
    expect(view.results).toHaveLength(5);
    expect(events.map((e) => e.n)).toEqual([1, 2, 3, 4, 5]);
    expect(events[4]!.gameFinished).toBe(true);
    expect(events[0]!.roomCode).toBeNull();
    expect(await code(h.services.games.openRound(game.id, pid))).toBe('conflict');
    const summary = await h.services.games.summary(game.id, pid, 'http://x');
    expect(summary.leaderboard.entries[0]).toMatchObject({ rank: 1, playerId: pid, total, timeMs: 15000, me: true });
    expect(summary.shareText).toBeUndefined();
  });

  it('wrong world scores 0 with distance null; give-up scores 0', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    const round = await h.services.games.openRound(game.id, pid);
    const answer = answerOf(round);
    const other = answer.world === 'alpha' ? 'beta' : 'alpha';
    const r1 = await h.services.games.guess(game.id, pid, { world: other, x: answer.x, z: answer.z });
    expect(r1).toMatchObject({ score: 0, distanceM: null, timedOut: false });
    await h.services.games.openRound(game.id, pid);
    const r2 = await h.services.games.guess(game.id, pid, null);
    expect(r2).toMatchObject({ guess: null, score: 0, distanceM: null, timedOut: false });
  });

  it('rejects guesses on worlds outside the settings and malformed guesses', async () => {
    const game = await h.services.games.createSolo(pid, { ...SOLO, worlds: ['alpha'] });
    await h.services.games.openRound(game.id, pid);
    for (const bad of [{ world: 'beta', x: 0, z: 0 }, { world: 'alpha', x: 'a', z: 0 }, { world: 'alpha', x: Infinity, z: 0 }, 5, []]) {
      expect(await code(h.services.games.guess(game.id, pid, bad))).toBe('bad_request');
    }
  });

  it('hides other players\' games', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    expect(await code(h.services.games.getGame(game.id, pid2))).toBe('not_found');
    expect(await code(h.services.games.openRound(game.id, pid2))).toBe('not_found');
    expect(await code(h.services.games.guess(game.id, pid2, null))).toBe('not_found');
  });

  it('classic in a small world draws its 5 rounds from the outdoor starts', async () => {
    // beta has 9 starts, 5 of them outdoor (even ids) → classic in beta still has 5 rounds.
    const game = await h.services.games.createSolo(pid, { ...SOLO, mode: 'classic', worlds: ['beta'] });
    expect(game.totalRounds).toBe(5);
  });
});

describe('node reach check', () => {
  it('walks the graph one link at a time; resume keeps the position', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    const round = await h.services.games.openRound(game.id, pid);
    const start = await h.services.games.getNode(game.id, pid, round.start.key);
    expect(start).toEqual(round.start);
    const next = start.links[0]!.key;
    const nextNode = await h.services.games.getNode(game.id, pid, next);
    // Something two steps away that is not a link of the start.
    const startLinks = new Set(start.links.map((l) => l.key));
    const twoAway = nextNode.links.map((l) => l.key).find((k) => k !== start.key && !startLinks.has(k));
    if (twoAway) {
      // reachable now, since `next` was seen
      await h.services.games.getNode(game.id, pid, twoAway);
    }
    const view = await h.services.games.getGame(game.id, pid);
    expect(view.currentKey).toBe(twoAway ?? next);
    // A key of the other world / unknown key → not_found
    expect(await code(h.services.games.getNode(game.id, pid, 'nosuchkey1'))).toBe('not_found');
  });

  it('refuses nodes not adjacent to anything seen', async () => {
    const game = await h.services.games.createSolo(pid, { ...SOLO, worlds: ['alpha'] });
    const round = await h.services.games.openRound(game.id, pid);
    const world = h.services.worlds.get('alpha')!;
    const startNode = nodeByKey(world, round.start.key)!;
    const near = new Set([startNode.id, ...startNode.links.map((l) => l.to)]);
    const far = world.manifest.nodes.find((n) => !near.has(n.id))!;
    expect(await code(h.services.games.getNode(game.id, pid, far.key))).toBe('not_found');
  });

  it('No move: the start has no links and neighbours are refused', async () => {
    const game = await h.services.games.createSolo(pid, { ...SOLO, worlds: ['alpha'], noMove: true });
    const round = await h.services.games.openRound(game.id, pid);
    expect(round.start.links).toEqual([]);
    const world = h.services.worlds.get('alpha')!;
    const neighbour = world.manifest.nodes[nodeByKey(world, round.start.key)!.links[0]!.to]!;
    expect(await code(h.services.games.getNode(game.id, pid, neighbour.key))).toBe('not_found');
    expect((await h.services.games.getNode(game.id, pid, round.start.key)).links).toEqual([]);
  });

  it('no open round → not_found; after guessing the round is over', async () => {
    const game = await h.services.games.createSolo(pid, SOLO);
    expect(await code(h.services.games.getNode(game.id, pid, 'alpha0000'))).toBe('not_found');
    const round = await h.services.games.openRound(game.id, pid);
    await h.services.games.guess(game.id, pid, null);
    expect(await code(h.services.games.getNode(game.id, pid, round.start.key))).toBe('not_found');
  });
});

describe('deadlines', () => {
  const TIMED: PublicSettings = { ...SOLO, timeLimit: 30 };

  it('counts a guess within the 2 s grace, clamping time to the limit', async () => {
    const game = await h.services.games.createSolo(pid, TIMED);
    const round = await h.services.games.openRound(game.id, pid);
    expect(round.deadline).toBe(round.startedAt + 30_000);
    const answer = answerOf(round);
    h.clock.now = round.deadline! + DEADLINE_GRACE_MS - 1;
    const r = await h.services.games.guess(game.id, pid, answer);
    expect(r).toMatchObject({ score: 5000, timeMs: 30_000, timedOut: false, distanceM: 0 });
  });

  it('records a timeout (score 0) for a guess after deadline + grace', async () => {
    const game = await h.services.games.createSolo(pid, TIMED);
    const round = await h.services.games.openRound(game.id, pid);
    const answer = answerOf(round);
    h.clock.now = round.deadline! + DEADLINE_GRACE_MS + 1;
    const r = await h.services.games.guess(game.id, pid, answer);
    expect(r).toMatchObject({ guess: null, score: 0, distanceM: null, timeMs: 30_000, timedOut: true });
  });

  it('a null guess after the deadline (client timer) is a timeout', async () => {
    const game = await h.services.games.createSolo(pid, TIMED);
    const round = await h.services.games.openRound(game.id, pid);
    h.clock.now = round.deadline! + 500;
    expect(await h.services.games.guess(game.id, pid, null)).toMatchObject({ timedOut: true, score: 0, timeMs: 30_000 });
  });

  it('expires the open round lazily on GET and on node lookups', async () => {
    const game = await h.services.games.createSolo(pid, TIMED);
    const events: GuessEvent[] = [];
    h.services.events.on('guess', (e) => events.push(e));
    const round = await h.services.games.openRound(game.id, pid);
    h.clock.now = round.deadline! + DEADLINE_GRACE_MS + 10;
    expect(await code(h.services.games.getNode(game.id, pid, round.start.key))).toBe('round_over');
    const view = await h.services.games.getGame(game.id, pid);
    expect(view.current).toBeNull();
    expect(view.results[0]).toMatchObject({ n: 1, timedOut: true, score: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.result.timedOut).toBe(true);
    // The next round opens normally with a fresh deadline.
    const r2 = await h.services.games.openRound(game.id, pid);
    expect(r2).toMatchObject({ n: 2, deadline: h.clock.now + 30_000 });
  });

  it('openRound after an expired round closes it and opens the next', async () => {
    const game = await h.services.games.createSolo(pid, TIMED);
    const r1 = await h.services.games.openRound(game.id, pid);
    h.clock.now = r1.deadline! + 60_000;
    const r2 = await h.services.games.openRound(game.id, pid);
    expect(r2.n).toBe(2);
  });
});

describe('challenges: one attempt per player', () => {
  it('second player gets the same rounds; replays are refused, unfinished games resume', async () => {
    const g1 = await h.services.games.createSolo(pid, SOLO);
    const keys1: string[] = [];
    for (let i = 0; i < 5; i++) {
      keys1.push((await h.services.games.openRound(g1.id, pid)).start.key);
      await h.services.games.guess(g1.id, pid, null);
    }
    expect(await code(h.services.games.joinChallenge(pid, g1.challengeCode))).toBe('already_played');

    const g2 = await h.services.games.joinChallenge(pid2, g1.challengeCode);
    expect(g2).toMatchObject({ kind: 'challenge', challengeCode: g1.challengeCode, settings: g1.settings });
    const first = await h.services.games.openRound(g2.id, pid2);
    expect(first.start.key).toBe(keys1[0]);
    const resumed = await h.services.games.joinChallenge(pid2, g1.challengeCode);
    expect(resumed.id).toBe(g2.id);
    expect(resumed.current?.n).toBe(1);
    expect(await code(h.services.games.joinChallenge(pid2, 'nope2345'))).toBe('not_found');

    const view = await h.services.games.challengeView(g1.challengeCode, pid2);
    expect(view).toMatchObject({ kind: 'solo', players: 1, myGame: { id: g2.id, finished: false, total: 0 } });
    expect(view.createdBy).toMatch(/^Nameless Hero \d{4}$/);
    expect(JSON.stringify(view)).not.toContain('seed');
  });
});

describe('leaderboard', () => {
  async function finishWith(playerId: string, codeArg: string | null, scores: 'perfect' | 'zero', stepMs: number): Promise<GameView> {
    const game = codeArg ? await h.services.games.joinChallenge(playerId, codeArg) : await h.services.games.createSolo(playerId, SOLO);
    for (let i = 0; i < 5; i++) {
      const round = await h.services.games.openRound(game.id, playerId);
      h.clock.advance(stepMs);
      await h.services.games.guess(game.id, playerId, scores === 'perfect' ? answerOf(round) : null);
    }
    return h.services.games.getGame(game.id, playerId);
  }

  it('orders by total desc, time asc, finish asc; excludes banned and hidden; reports my rank', async () => {
    const owner = await finishWith(pid, null, 'perfect', 3000); // 25000, 15 s
    const challenge = owner.challengeCode;
    const p3 = (await h.services.players.create()).player.id;
    const p4 = (await h.services.players.create()).player.id;
    const p5 = (await h.services.players.create()).player.id;
    await finishWith(pid2, challenge, 'perfect', 1000); // 25000, 5 s → first
    await finishWith(p3, challenge, 'zero', 1000); // 0
    await finishWith(p4, challenge, 'perfect', 3000); // 25000, 15 s, finished later than owner
    await finishWith(p5, challenge, 'perfect', 500); // banned below

    await h.services.repo.setBanned(p5, true, h.clock.now, 'test');
    const board = await h.services.games.leaderboard(challenge, pid, 50);
    expect(board.entries.map((e) => e.playerId)).toEqual([pid2, pid, p4, p3]);
    expect(board.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    expect(board.entries[0]!.rounds).toEqual([5000, 5000, 5000, 5000, 5000]);
    expect(board.total).toBe(4);
    expect(board.me).toMatchObject({ playerId: pid, rank: 2, me: true });

    const limited = await h.services.games.leaderboard(challenge, p3, 2);
    expect(limited.entries).toHaveLength(2);
    expect(limited.me).toMatchObject({ playerId: p3, rank: 4 });

    // Banned player sees no own row; hidden entries vanish too.
    expect((await h.services.games.leaderboard(challenge, p5, 50)).me).toBeNull();
    const g2 = await h.services.repo.getGameOf(challenge, pid2);
    h.services.repo.db.prepare('UPDATE games SET hidden = 1 WHERE id = ?').run(g2!.id);
    const after = await h.services.games.leaderboard(challenge, null, 50);
    expect(after.entries.map((e) => e.playerId)).toEqual([pid, p4, p3]);
    expect(after.me).toBeNull();
  });

  it('SQL order agrees with the core comparator on random data', async () => {
    const { rankRows } = await import('../../server/core/leaderboard');
    const owner = await h.services.games.createSolo(pid, SOLO);
    const db = h.services.repo.db;
    const rows: { gameId: string; total: number; timeMs: number; finishedAt: number }[] = [];
    for (let i = 0; i < 40; i++) {
      const p = (await h.services.players.create()).player.id;
      const g = await h.services.games.joinChallenge(p, owner.challengeCode);
      const row = { gameId: g.id, total: [0, 100, 200][i % 3]!, timeMs: [5, 7][i % 2]!, finishedAt: 1000 + (i % 4) };
      db.prepare('UPDATE games SET total = ?, time_ms = ?, finished_at = ? WHERE id = ?').run(row.total, row.timeMs, row.finishedAt, row.gameId);
      rows.push(row);
    }
    const sql = await h.services.games.leaderboard(owner.challengeCode, null, 200);
    expect(sql.entries.map((e) => e.rank)).toEqual(rankRows(rows).map((r) => r.rank));
    const byGame = new Map(rows.map((r) => [r.gameId, r]));
    const games = await h.services.repo.listGamesOfChallenge(owner.challengeCode);
    const playerToGame = new Map(games.map((g) => [g.playerId, g.id]));
    expect(sql.entries.map((e) => playerToGame.get(e.playerId))).toEqual(rankRows(rows).map((r) => r.gameId));
    for (const e of sql.entries) {
      const entry = await h.services.repo.leaderboardEntry(owner.challengeCode, playerToGame.get(e.playerId)!);
      expect(entry?.rank).toBe(e.rank);
      expect(byGame.has(entry!.gameId)).toBe(true);
    }
  });
});

describe('daily', () => {
  it('same rounds for everyone, one attempt, share text', async () => {
    const view = await h.services.games.dailyView(null, pid);
    expect(view).toMatchObject({ code: 'daily-2026-10-07', kind: 'daily', date: '2026-10-07', myGame: null, players: 0 });
    expect(view.settings).toEqual({ mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 120, rounds: 5 });

    const g1 = await h.services.games.joinDaily(pid);
    const g2 = await h.services.games.joinDaily(pid2);
    expect(g1.kind).toBe('daily');
    expect(g1.date).toBe('2026-10-07');
    expect((await h.services.games.joinDaily(pid)).id).toBe(g1.id); // resume
    const keys: string[][] = [[], []];
    for (let i = 0; i < 5; i++) {
      const r1 = await h.services.games.openRound(g1.id, pid);
      const r2 = await h.services.games.openRound(g2.id, pid2);
      expect(r1.deadline).toBe(h.clock.now + 120_000);
      keys[0]!.push(r1.start.key);
      keys[1]!.push(r2.start.key);
      h.clock.advance(2000);
      await h.services.games.guess(g1.id, pid, i === 4 ? null : answerOf(r1));
      await h.services.games.guess(g2.id, pid2, null);
    }
    expect(keys[0]).toEqual(keys[1]);
    expect(await code(h.services.games.joinDaily(pid))).toBe('already_played');
    const summary = await h.services.games.summary(g1.id, pid, 'https://g2.example');
    expect(summary.shareText).toBe('Gothic Guessr — Daily 2026-10-07\n20 000 / 25 000\n🟩🟩🟩🟩⬛\nhttps://g2.example/daily');
    expect((await h.services.games.dailyView('2026-10-07', pid)).myGame).toMatchObject({ id: g1.id, finished: true, total: 20000 });
  });

  it('is deterministic per date across restarts (seed from SERVER_SECRET)', async () => {
    const view = await h.services.games.dailyView(null, null);
    const challenge = await h.services.repo.getChallenge(view.code);
    const other = harness();
    try {
      const view2 = await other.services.games.dailyView(null, null);
      const challenge2 = await other.services.repo.getChallenge(view2.code);
      expect(challenge2!.picks).toEqual(challenge!.picks);
      expect(challenge2!.seed).toBe(challenge!.seed);
    } finally {
      other.close();
    }
    const differentSecret = harness({ config: { serverSecret: 'another-secret-value-123' } });
    try {
      const c3 = await differentSecret.services.repo.getChallenge((await differentSecret.services.games.dailyView(null, null)).code);
      expect(c3!.seed).not.toBe(challenge!.seed);
    } finally {
      differentSecret.close();
    }
  });

  it('past days are browsable but not playable; future days do not exist', async () => {
    expect(await code(h.services.games.dailyView('2026-10-08', null))).toBe('not_found');
    expect(await code(h.services.games.dailyView('2026-13-01', null))).toBe('bad_request');
    expect(await code(h.services.games.dailyView('2026-10-01', null))).toBe('not_found'); // never created
    const today = await h.services.games.joinDaily(pid);
    h.clock.advance(24 * 3600_000);
    const past = await h.services.games.dailyView('2026-10-07', pid);
    expect(past).toMatchObject({ date: '2026-10-07', myGame: { id: today.id } });
    expect(await code(h.services.games.joinChallenge(pid, past.code))).toBe('forbidden');
    const tomorrow = await h.services.games.joinDaily(pid);
    expect(tomorrow.date).toBe('2026-10-08');
  });

  it('admin override: free before plays, needs force after; re-draws picks with the same seed', async () => {
    const custom = { mode: 'classic', worlds: ['beta'], noMove: true, noLook: false, timeLimit: 60 };
    const before = await h.services.games.setDailyOverride('2026-10-07', custom);
    expect(before.settings).toEqual({ ...custom, rounds: 5 });
    expect((await h.services.games.dailySettings('2026-10-07')).overridden).toBe(true);
    const g = await h.services.games.joinDaily(pid);
    expect(g.settings.worlds).toEqual(['beta']);
    expect(await code(h.services.games.setDailyOverride('2026-10-07', SOLO))).toBe('conflict');
    const forced = await h.services.games.setDailyOverride('2026-10-07', SOLO, { force: true });
    expect(forced.settings.worlds).toEqual(['alpha', 'beta']);
    const cleared = await h.services.games.clearDailyOverride('2026-10-07', { force: true });
    expect(cleared.settings.timeLimit).toBe(120);
    // Future date: no challenge yet → stored and used when the day comes.
    await h.services.games.setDailyOverride('2026-10-09', custom);
    h.clock.advance(2 * 24 * 3600_000);
    expect((await h.services.games.dailyView(null, null)).settings.worlds).toEqual(['beta']);
  });
});

describe('room API', () => {
  const PARTY = { mode: 'mixed', worlds: ['alpha', 'beta'], noMove: false, noLook: false, timeLimit: 60, rounds: 3 };

  it('creates games for every player, opens rounds at the same instant, closes with timeouts, finishes', async () => {
    const p3 = (await h.services.players.create()).player.id;
    const room = await h.services.games.createRoomGames({ type: 'party', settings: PARTY, roomCode: 'ABCDE', hostId: pid, playerIds: [pid, pid2, p3] });
    expect(room.rounds).toBe(3);
    expect(Object.keys(room.games).sort()).toEqual([pid, pid2, p3].sort());
    const g1 = room.games[pid]!;

    // Players cannot drive rounds themselves, and the link is not playable while running.
    expect(await code(h.services.games.openRound(g1, pid))).toBe('forbidden');
    const friend = (await h.services.players.create()).player.id;
    expect(await code(h.services.games.joinChallenge(friend, room.challengeCode))).toBe('conflict');

    const events: GuessEvent[] = [];
    h.services.events.on('guess', (e) => events.push(e));
    for (let n = 1; n <= 3; n++) {
      const startedAt = h.clock.now;
      const opened = await h.services.games.openRoomRound(room.challengeCode, n, { startedAt, deadline: startedAt + 60_000 });
      for (const [player, gameId] of Object.entries(room.games)) {
        const view = await h.services.games.getGame(gameId, player);
        expect(view.current).toMatchObject({ n, startedAt, deadline: startedAt + 60_000, start: opened.node });
        expect(view.roomCode).toBe('ABCDE');
      }
      h.clock.advance(4000);
      const answer = answerOf({ n, start: opened.node, deadline: null, startedAt });
      await h.services.games.guess(room.games[pid]!, pid, answer);
      await h.services.games.guess(room.games[pid2]!, pid2, null);
      // p3 never guesses (disconnected)
      const closed = await h.services.games.closeRoomRound(room.challengeCode, n);
      expect(closed.answer).toEqual(answer);
      const byPlayer = Object.fromEntries(closed.results.map((r) => [r.playerId, r]));
      expect(byPlayer[pid]).toMatchObject({ score: 5000, distanceM: 0, timeMs: 4000 });
      expect(byPlayer[pid2]).toMatchObject({ score: 0, guess: null });
      expect(byPlayer[p3]).toMatchObject({ score: 0, guess: null, timeMs: 4000 });
    }
    expect(events.filter((e) => e.roomCode === 'ABCDE')).toHaveLength(6);
    await h.services.games.finishRoomChallenge(room.challengeCode, 3);
    for (const [player, gameId] of Object.entries(room.games)) {
      expect((await h.services.games.getGame(gameId, player)).finished).toBe(true);
    }
    const board = await h.services.games.leaderboard(room.challengeCode, null);
    expect(board.entries[0]).toMatchObject({ playerId: pid, total: 15000, rounds: [5000, 5000, 5000] });
    expect(board.entries.slice(1).map((e) => e.playerId).sort()).toEqual([pid2, p3].sort());
    expect(board.entries.slice(1).every((e) => e.total === 0 && e.timeMs === 12000)).toBe(true);
    // The link is now playable by friends with the same rounds.
    const fg = await h.services.games.joinChallenge(friend, room.challengeCode);
    expect(fg).toMatchObject({ kind: 'challenge', totalRounds: 3 });
    expect((await h.services.games.openRound(fg.id, friend)).n).toBe(1);
  });

  it('duel: deadline can be moved, totalRounds grows, finish truncates the challenge', async () => {
    const room = await h.services.games.createRoomGames({
      type: 'duel',
      settings: { ...PARTY, timeLimit: 0 },
      roomCode: 'DUELX',
      hostId: pid,
      playerIds: [pid, pid2],
    });
    expect(room.rounds).toBe(29); // alpha 20 + beta 9 starts < cap 30
    const g1 = room.games[pid]!;
    for (let n = 1; n <= 2; n++) {
      const startedAt = h.clock.now;
      await h.services.games.openRoomRound(room.challengeCode, n, { startedAt, deadline: startedAt + 300_000 });
      expect((await h.services.games.getGame(g1, pid)).totalRounds).toBe(n);
      h.clock.advance(1000);
      await h.services.games.guess(g1, pid, null);
      await h.services.games.setRoomRoundDeadline(room.challengeCode, n, h.clock.now + 15_000);
      expect((await h.services.games.getGame(room.games[pid2]!, pid2)).current?.deadline).toBe(h.clock.now + 15_000);
      h.clock.advance(15_000 + DEADLINE_GRACE_MS + 1);
      // Late guess of the second player → timeout
      expect(await h.services.games.guess(room.games[pid2]!, pid2, { world: 'alpha', x: 0, z: 0 })).toMatchObject({ timedOut: true });
      await h.services.games.closeRoomRound(room.challengeCode, n);
    }
    await h.services.games.finishRoomChallenge(room.challengeCode, 2);
    const view = await h.services.games.getGame(g1, pid);
    expect(view).toMatchObject({ finished: true, totalRounds: 2 });
    expect(view.settings.rounds).toBe(2);
    const challenge = await h.services.games.challengeView(room.challengeCode, null);
    expect(challenge).toMatchObject({ kind: 'duel', players: 2 });
  });

  it('openRoomRound closes a still-open previous round as timeout', async () => {
    const room = await h.services.games.createRoomGames({ type: 'party', settings: PARTY, roomCode: 'QQQQQ', hostId: pid, playerIds: [pid] });
    await h.services.games.openRoomRound(room.challengeCode, 1, { startedAt: h.clock.now, deadline: null });
    h.clock.advance(1000);
    await h.services.games.openRoomRound(room.challengeCode, 2, { startedAt: h.clock.now, deadline: null });
    const view = await h.services.games.getGame(room.games[pid]!, pid);
    expect(view.results).toHaveLength(1);
    expect(view.results[0]).toMatchObject({ timedOut: true, timeMs: 1000 });
    expect(view.current?.n).toBe(2);
    expect(await code(h.services.games.openRoomRound(room.challengeCode, 99, { startedAt: 0, deadline: null }))).toBe('bad_request');
    expect(await code(h.services.games.openRoomRound('nosuch', 1, { startedAt: 0, deadline: null }))).toBe('not_found');
  });

  it('startup recovery finishes room games a previous process left running and opens their links', async () => {
    // Room 1 crashed in round 2 (round 1 closed, round 2 open, one guess in).
    const r1 = await h.services.games.createRoomGames({ type: 'party', settings: PARTY, roomCode: 'CRASH', hostId: pid, playerIds: [pid, pid2] });
    const s1 = h.clock.now;
    const o1 = await h.services.games.openRoomRound(r1.challengeCode, 1, { startedAt: s1, deadline: s1 + 60_000 });
    h.clock.advance(2000);
    await h.services.games.guess(r1.games[pid]!, pid, answerOf({ n: 1, start: o1.node, deadline: null, startedAt: s1 }));
    await h.services.games.closeRoomRound(r1.challengeCode, 1);
    await h.services.games.openRoomRound(r1.challengeCode, 2, { startedAt: h.clock.now, deadline: null });
    h.clock.advance(1000);
    await h.services.games.guess(r1.games[pid2]!, pid2, { world: 'alpha', x: 0, z: 0 });
    // Room 2 crashed before its first round opened.
    const r2 = await h.services.games.createRoomGames({ type: 'duel', settings: { ...PARTY, timeLimit: 0 }, roomCode: 'EARLY', hostId: pid, playerIds: [pid, pid2] });
    const friend = (await h.services.players.create()).player.id;
    expect((await h.services.games.challengeView(r1.challengeCode, friend)).unavailable).toBe('running');
    expect(await code(h.services.games.joinChallenge(friend, r1.challengeCode))).toBe('conflict');

    h.clock.advance(60_000);
    const recovered = await h.services.games.recoverRoomChallenges();
    expect(recovered.sort()).toEqual([r1.challengeCode, r2.challengeCode].sort());

    // Room 1: games finished with 2 rounds, the link plays those 2 rounds.
    for (const [player, gameId] of Object.entries(r1.games)) {
      const view = await h.services.games.getGame(gameId, player);
      expect(view).toMatchObject({ finished: true, totalRounds: 2 });
      expect(view.results).toHaveLength(2);
    }
    expect((await h.services.games.getGame(r1.games[pid]!, pid)).results[1]).toMatchObject({ guess: null, timedOut: true });
    const v1 = await h.services.games.challengeView(r1.challengeCode, friend);
    expect(v1.unavailable).toBeUndefined();
    expect(v1).toMatchObject({ kind: 'party', players: 2 });
    const fg = await h.services.games.joinChallenge(friend, r1.challengeCode);
    expect(fg).toMatchObject({ kind: 'challenge', totalRounds: 2 });
    // Room 2: nothing was played; the games are finished and the link says so.
    for (const [player, gameId] of Object.entries(r2.games)) {
      expect((await h.services.games.getGame(gameId, player)).finished).toBe(true);
    }
    expect((await h.services.games.challengeView(r2.challengeCode, friend)).unavailable).toBe('abandoned');
    expect(await code(h.services.games.joinChallenge(friend, r2.challengeCode))).toBe('conflict');
    // Idempotent: a second start finds nothing left to do.
    expect(await h.services.games.recoverRoomChallenges()).toEqual([]);
  });
});
