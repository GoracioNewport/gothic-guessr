/**
 * Duel rules (server/core/duel.ts) and duel rooms in the state machine (server/core/party.ts): damage math,
 * multipliers, the 15 s countdown, the 5 min hard cap, KO, the round cap with win/draw, and forfeits.
 */
import { describe, expect, it } from 'vitest';
import {
  DUEL_COUNTDOWN_MS,
  DUEL_FORFEIT_MS,
  DUEL_RESULT_MS,
  DUEL_START_HP,
  DuelMatch,
  duelCountdownDeadline,
  duelForfeiter,
  duelMultiplier,
  duelRoundDeadline,
} from '../../server/core/duel';
import { DEADLINE_GRACE_MS } from '../../server/core/settings';
import { T0 } from './helpers';
import { RoomDriver, settingsFor } from './party-driver';

describe('duel math', () => {
  it('multiplier ×1 for rounds 1–3, then +0.5 per round', () => {
    expect([1, 2, 3, 4, 5, 6, 10, 30].map(duelMultiplier)).toEqual([1, 1, 1, 1.5, 2, 2.5, 4.5, 14.5]);
  });

  it('the lower score loses the difference × multiplier, rounded, never below 0', () => {
    const m = new DuelMatch(['a', 'b']);
    expect(m.hp()).toEqual({ a: DUEL_START_HP, b: DUEL_START_HP });
    let r = m.applyRound(1, { a: 5000, b: 3000 });
    expect(r).toEqual({ n: 1, multiplier: 1, hp: { a: 6000, b: 4000 }, damage: { a: 0, b: 2000 }, over: false, winner: null });
    r = m.applyRound(2, { a: 1200, b: 1200 });
    expect(r.damage).toEqual({ a: 0, b: 0 });
    r = m.applyRound(4, { a: 0, b: 1001 }); // ×1.5 → 1501.5 → 1502
    expect(r.damage).toEqual({ a: 1502, b: 0 });
    expect(r.hp).toEqual({ a: 4498, b: 4000 });
    r = m.applyRound(5, { b: 3000 }); // missing score = 0; ×2 → 6000 > 4498 hp
    expect(r).toMatchObject({ hp: { a: 0, b: 4000 }, damage: { a: 4498, b: 0 }, over: true, winner: 'b' });
  });

  it('after the last round the higher HP wins; equal HP is a draw', () => {
    const win = new DuelMatch(['a', 'b'], 2);
    expect(win.applyRound(1, { a: 100, b: 0 }).over).toBe(false);
    expect(win.applyRound(2, { a: 0, b: 0 })).toMatchObject({ over: true, winner: 'a' });
    const draw = new DuelMatch(['a', 'b'], 1);
    expect(draw.applyRound(1, { a: 2500, b: 2500 })).toMatchObject({ over: true, winner: null, hp: { a: 6000, b: 6000 } });
    expect(new DuelMatch(['a', 'b'], 99).maxRounds).toBe(30);
    expect(() => new DuelMatch(['a'])).toThrow();
    expect(() => new DuelMatch(['a', 'a'])).toThrow();
  });

  it('deadlines: base limit or the 5 min hard cap; countdown is 15 s or the remaining time', () => {
    expect(duelRoundDeadline(T0, 0)).toBe(T0 + 300_000);
    expect(duelRoundDeadline(T0, 60)).toBe(T0 + 60_000);
    expect(duelRoundDeadline(T0, 300)).toBe(T0 + 300_000);
    expect(duelCountdownDeadline(T0, T0 + 60_000)).toBe(T0 + DUEL_COUNTDOWN_MS);
    expect(duelCountdownDeadline(T0, T0 + 10_000)).toBe(T0 + 10_000);
    expect(duelCountdownDeadline(T0, null)).toBe(T0 + DUEL_COUNTDOWN_MS);
  });

  it('forfeit: away for more than 60 s; with both away the earlier one', () => {
    const away = (id: string, at: number | null) => ({ id, connected: at === null, disconnectedAt: at });
    expect(duelForfeiter([away('a', T0), away('b', null)], T0 + DUEL_FORFEIT_MS)).toBeNull();
    expect(duelForfeiter([away('a', T0), away('b', null)], T0 + DUEL_FORFEIT_MS + 1)).toBe('a');
    expect(duelForfeiter([away('a', T0 + 5), away('b', T0)], T0 + 2 * DUEL_FORFEIT_MS)).toBe('b');
  });
});

function duelRoom(settings = settingsFor('duel')): RoomDriver {
  const d = new RoomDriver('duel', 'ann', settings);
  d.join('ann');
  d.join('ben');
  return d;
}

describe('duel room', () => {
  it('capacity 2; needs both players connected to start', () => {
    const d = duelRoom();
    expect(d.join('cid')).toEqual([{ type: 'send', to: 'cid', msg: { t: 'error', error: 'room_full' } }]);
    d.run({ type: 'disconnect', playerId: 'ben' });
    d.run({ type: 'start', playerId: 'ann' });
    expect(d.errors('ann')).toEqual(['conflict']);
    d.join('ben');
    d.run({ type: 'start', playerId: 'ann' });
    expect(d.callsOf('createGames')).toHaveLength(1);
    const round = d.last('ben', 'round')!;
    expect(round).toEqual({
      t: 'round',
      n: 1,
      node: { key: 'key1', links: [] },
      deadline: T0 + 300_000, // base limit off → 5 min hard cap
      startedAt: T0,
      duel: { hp: { ann: 6000, ben: 6000 }, multiplier: 1 },
    });
    expect(d.last('ann', 'room')!.room.players.map((p) => p.hp)).toEqual([6000, 6000]);
  });

  it('first guess starts the 15 s countdown; both guessed → result with damage', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    d.clock.advance(20_000);
    d.guess('ann');
    const countdown = T0 + 20_000 + DUEL_COUNTDOWN_MS;
    expect(d.callsOf('setDeadline')).toEqual([{ op: 'setDeadline', challengeCode: 'chal0001', n: 1, deadline: countdown }]);
    expect(d.last('ben', 'countdown')).toEqual({ t: 'countdown', deadline: countdown });
    expect(d.machine.nextWakeAt()).toBe(countdown + DEADLINE_GRACE_MS);
    d.scores = { ann: 4500, ben: 1500 };
    d.clock.advance(3000);
    d.guess('ben');
    expect(d.callsOf('closeRound')).toHaveLength(1);
    const result = d.last('ann', 'roundResult')!;
    expect(result.duel).toEqual({ hp: { ann: 6000, ben: 3000 }, multiplier: 1, damage: { ann: 0, ben: 3000 } });
    expect(result.nextAt).toBe(T0 + 23_000 + DUEL_RESULT_MS);
    expect(d.last('ben', 'room')!.room.players.map((p) => p.hp)).toEqual([6000, 3000]);
  });

  it('countdown never extends a shorter remaining time; the round closes at deadline + grace', () => {
    const d = duelRoom(settingsFor('duel', { timeLimit: 30 }));
    d.run({ type: 'start', playerId: 'ann' });
    const deadline = T0 + 30_000;
    d.clock.now = deadline - 5000;
    d.guess('ben');
    expect(d.callsOf('setDeadline')).toHaveLength(0);
    expect(d.last('ann', 'countdown')).toEqual({ t: 'countdown', deadline });
    d.tickAt(deadline + DEADLINE_GRACE_MS - 1);
    expect(d.callsOf('closeRound')).toHaveLength(0);
    d.scores = { ben: 2000 };
    d.tickAt(deadline + DEADLINE_GRACE_MS);
    expect(d.callsOf('closeRound')).toHaveLength(1);
    expect(d.last('ann', 'roundResult')!.duel!.hp).toEqual({ ann: 4000, ben: 6000 });
  });

  it('plays until KO with growing multipliers, then gameOver names the winner', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    // Rounds 1–3: ben loses 1000 each (×1) → 3000; round 4 ×1.5: 2000 diff → 3000 → KO.
    const diffs = [1000, 1000, 1000, 2000];
    for (const [i, diff] of diffs.entries()) {
      const n = i + 1;
      expect(d.last('ann', 'round')!.duel!.multiplier).toBe(duelMultiplier(n));
      d.scores = { ann: 3000 + diff, ben: 3000 };
      d.guess('ann');
      d.guess('ben');
      expect(d.last('ben', 'roundResult')!.n).toBe(n);
      d.tickAt(d.last('ben', 'roundResult')!.nextAt!);
    }
    expect(d.callsOf('openRound')).toHaveLength(4);
    expect(d.callsOf('finish')).toEqual([{ op: 'finish', challengeCode: 'chal0001', roundsPlayed: 4 }]);
    const over = d.last('ben', 'gameOver')!;
    expect(over.winner).toBe('ann');
    expect(over.reason).toBe('ko');
    expect(over.standings.map((s) => [s.playerId, s.hp, s.total])).toEqual([
      ['ann', 6000, 17000],
      ['ben', 0, 12000],
    ]);
    expect(d.machine.publicPhase).toBe('over');
    expect(d.last('ann', 'room')!.room.players.map((p) => p.hp)).toEqual([6000, 0]);
  });

  it('the round cap ends the match: higher HP wins, equal HP is a draw', () => {
    const d = duelRoom();
    d.duelRounds = 2; // the worlds only had 2 start nodes
    d.run({ type: 'start', playerId: 'ann' });
    for (let n = 1; n <= 2; n++) {
      d.scores = { ann: 1000, ben: 1000 };
      d.guess('ann');
      d.guess('ben');
      d.run({ type: 'next', playerId: 'ann' });
    }
    expect(d.last('ann', 'gameOver')!.winner).toBeNull();
    expect(d.last('ann', 'gameOver')!.reason).toBe('cap');

    // Back in the lobby: start again, ben ahead after the cap.
    d.run({ type: 'start', playerId: 'ann' });
    for (let n = 1; n <= 2; n++) {
      d.scores = { ann: 1000, ben: 1100 };
      d.guess('ann');
      d.guess('ben');
      d.run({ type: 'next', playerId: 'ann' });
    }
    expect(d.last('ann', 'gameOver')!.winner).toBe('ben');
    expect(d.last('ann', 'gameOver')!.reason).toBe('cap');
    expect(d.last('ann', 'gameOver')!.standings[0]!.playerId).toBe('ben');
  });

  it('disconnected for more than 60 s forfeits; a reconnect in time does not', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    d.run({ type: 'disconnect', playerId: 'ben' });
    expect(d.machine.nextWakeAt()).toBe(T0 + DUEL_FORFEIT_MS + 1);
    d.tickAt(T0 + DUEL_FORFEIT_MS);
    expect(d.callsOf('finish')).toHaveLength(0);
    d.join('ben'); // back in time
    expect(d.got('ben', 'round')).toHaveLength(2);
    d.run({ type: 'disconnect', playerId: 'ben' });
    const away = d.clock.now;
    d.tickAt(away + DUEL_FORFEIT_MS + 1);
    expect(d.callsOf('finish')).toEqual([{ op: 'finish', challengeCode: 'chal0001', roundsPlayed: 1 }]);
    expect(d.last('ann', 'gameOver')!.winner).toBe('ann');
    expect(d.last('ann', 'gameOver')!.reason).toBe('forfeit');
    expect(d.machine.publicPhase).toBe('over');
  });

  it('leaving during a duel forfeits at once; kicking is refused', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    d.run({ type: 'kick', playerId: 'ann', target: 'ben' });
    expect(d.errors('ann')).toEqual(['forbidden']);
    d.guess('ann');
    d.run({ type: 'leave', playerId: 'ann' }); // the host leaves
    expect(d.callsOf('finish')).toHaveLength(1);
    const over = d.last('ben', 'gameOver')!;
    expect(over.winner).toBe('ben');
    expect(over.reason).toBe('forfeit');
    expect(d.machine.memberIds()).toEqual(['ben']);
    expect(d.machine.host).toBe('ben');
    // Kicking in the lobby is fine again.
    d.join('cid');
    d.run({ type: 'kick', playerId: 'ben', target: 'cid' });
    expect(d.got('cid', 'kicked')).toHaveLength(1);
  });

  it('a forfeit during a pending call is applied when the call returns', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    d.guess('ann');
    d.autoRespond = false;
    d.guess('ben'); // closeRound in flight
    d.run({ type: 'leave', playerId: 'ben' });
    expect(d.callsOf('finish')).toHaveLength(0);
    d.autoRespond = true;
    d.run(d.answer(d.callsOf('closeRound')[0]!)!);
    expect(d.got('ann', 'roundResult')).toHaveLength(1);
    expect(d.callsOf('finish')).toHaveLength(1);
    expect(d.last('ann', 'gameOver')!.winner).toBe('ann');
    expect(d.last('ann', 'gameOver')!.reason).toBe('forfeit');
  });

  it('endRound is a party control: refused in a duel', () => {
    const d = duelRoom();
    d.run({ type: 'start', playerId: 'ann' });
    d.run({ type: 'endRound', playerId: 'ann' });
    expect(d.errors('ann')).toEqual(['forbidden']);
    expect(d.callsOf('setDeadline')).toHaveLength(0);
  });
});
