/**
 * Room state machine, party rules (server/core/party.ts): lobby, capacity, settings, start, simultaneous rounds,
 * round end, auto-advance, disconnect/reconnect, host handover, kick, game over and back to the lobby, expiry.
 */
import { describe, expect, it } from 'vitest';
import { HOST_HANDOVER_MS, PARTY_CAPACITY, PARTY_RESULT_MS, ROOM_IDLE_MS, RoomMachine } from '../../server/core/party';
import { DEADLINE_GRACE_MS } from '../../server/core/settings';
import { END_ROUND_COUNTDOWN_MS } from '../../shared/api';
import { T0 } from './helpers';
import { RoomDriver, settingsFor, WORLDS } from './party-driver';

function lobby(...others: string[]): RoomDriver {
  const d = new RoomDriver('party');
  d.join('host');
  for (const id of others) d.join(id);
  return d;
}

function started(...others: string[]): RoomDriver {
  const d = lobby(...others);
  d.run({ type: 'start', playerId: 'host' });
  return d;
}

describe('party lobby', () => {
  it('the creator is the host; joins attach the socket and broadcast the room', () => {
    const d = new RoomDriver('party');
    expect(d.machine.view(null).players).toEqual([
      { id: 'host', nickname: 'host', host: true, connected: false, guessed: false, total: 0 },
    ]);
    const effects = d.join('host');
    expect(effects[0]).toEqual({ type: 'attach', playerId: 'host' });
    d.join('bob');
    const room = d.last('host', 'room')!.room;
    expect(room).toMatchObject({ code: 'ABCDE', type: 'party', phase: 'lobby', capacity: 16, round: 0, myGameId: null });
    expect(room.players.map((p) => [p.id, p.host, p.connected])).toEqual([
      ['host', true, true],
      ['bob', false, true],
    ]);
    expect(d.last('bob', 'room')!.room.players).toHaveLength(2);
  });

  it(`holds ${PARTY_CAPACITY} players, the next one gets room_full`, () => {
    const d = new RoomDriver('party');
    d.join('host');
    for (let i = 1; i < PARTY_CAPACITY; i++) d.join(`p${i}`);
    expect(d.machine.view(null).players).toHaveLength(PARTY_CAPACITY);
    const effects = d.join('late');
    expect(effects).toEqual([{ type: 'send', to: 'late', msg: { t: 'error', error: 'room_full' } }]);
  });

  it('settings: host only, validated, type switch respects capacity', () => {
    const d = lobby('bob', 'carl');
    d.run({ type: 'settings', playerId: 'bob', settings: settingsFor('party') });
    expect(d.errors('bob')).toEqual(['not_host']);
    d.run({ type: 'settings', playerId: 'host', settings: { mode: 'nope', worlds: WORLDS } });
    expect(d.errors('host')).toEqual(['bad_request']);
    d.run({ type: 'settings', playerId: 'host', settings: { mode: 'hardcore', worlds: ['beta'], timeLimit: 60, rounds: 10 } });
    expect(d.last('carl', 'room')!.room.settings).toMatchObject({ mode: 'hardcore', worlds: ['beta'], timeLimit: 60, rounds: 10 });
    d.run({ type: 'settings', playerId: 'host', settings: settingsFor('duel'), roomType: 'duel' });
    expect(d.errors('host')).toEqual(['bad_request', 'room_full']);
    expect(d.machine.type).toBe('party');
    d.run({ type: 'leave', playerId: 'carl' });
    d.run({ type: 'settings', playerId: 'host', settings: settingsFor('duel'), roomType: 'duel' });
    expect(d.machine.view(null)).toMatchObject({ type: 'duel', capacity: 2 });
    expect(d.machine.settings.rounds).toBe(30);
  });

  it('the last member leaving the lobby closes the room', () => {
    const d = lobby('bob');
    d.run({ type: 'leave', playerId: 'host' });
    expect(d.machine.host).toBe('bob');
    expect(d.last('bob', 'room')!.room.players.map((p) => [p.id, p.host])).toEqual([['bob', true]]);
    d.run({ type: 'leave', playerId: 'bob' });
    expect(d.closed).toBe('empty');
    expect(d.machine.closed).toBe(true);
    expect(d.join('carl')).toEqual([{ type: 'send', to: 'carl', msg: { t: 'error', error: 'room_closed' } }]);
  });

  it('kick: host only, removes the player, who cannot come back', () => {
    const d = lobby('bob', 'carl');
    d.run({ type: 'kick', playerId: 'bob', target: 'carl' });
    expect(d.errors('bob')).toEqual(['not_host']);
    d.run({ type: 'kick', playerId: 'host', target: 'host' });
    d.run({ type: 'kick', playerId: 'host', target: 'nobody' });
    expect(d.errors('host')).toEqual(['bad_request', 'not_found']);
    d.run({ type: 'kick', playerId: 'host', target: 'carl' });
    expect(d.got('carl', 'kicked')).toHaveLength(1);
    expect(d.attached.has('carl')).toBe(false);
    expect(d.machine.memberIds()).toEqual(['host', 'bob']);
    d.join('carl');
    expect(d.errors('carl')).toEqual(['forbidden']);
  });

  it('host handover after the host has been away for 30 s (not on a quick reload)', () => {
    const d = lobby('bob', 'carl');
    d.run({ type: 'disconnect', playerId: 'host' });
    expect(d.machine.nextWakeAt()).toBe(T0 + HOST_HANDOVER_MS);
    d.tickAt(T0 + HOST_HANDOVER_MS - 1);
    expect(d.machine.host).toBe('host');
    d.join('host'); // reload
    d.run({ type: 'disconnect', playerId: 'host' });
    d.run({ type: 'disconnect', playerId: 'bob' });
    d.tickAt(T0 + 2 * HOST_HANDOVER_MS);
    expect(d.machine.host).toBe('carl'); // earliest *connected* member
  });
});

describe('party game', () => {
  it('start: host only, needs a connected host, drops members whose socket is gone', () => {
    const d = lobby('bob', 'carl');
    d.run({ type: 'start', playerId: 'bob' });
    expect(d.errors('bob')).toEqual(['not_host']);
    d.run({ type: 'disconnect', playerId: 'carl' });
    d.run({ type: 'start', playerId: 'host' });
    expect(d.callsOf('createGames')).toEqual([
      { op: 'createGames', type: 'party', settings: settingsFor('party'), hostId: 'host', playerIds: ['host', 'bob'] },
    ]);
    expect(d.machine.memberIds()).toEqual(['host', 'bob']);
    expect(d.last('host', 'started')).toEqual({ t: 'started', gameId: 'game-host', challengeCode: 'chal0001' });
    expect(d.last('bob', 'started')).toEqual({ t: 'started', gameId: 'game-bob', challengeCode: 'chal0001' });
    const open = d.callsOf('openRound');
    expect(open).toEqual([{ op: 'openRound', challengeCode: 'chal0001', n: 1, startedAt: T0, deadline: null }]);
    expect(d.last('bob', 'round')).toEqual({ t: 'round', n: 1, node: { key: 'key1', links: [] }, deadline: null, startedAt: T0 });
    expect(d.last('host', 'room')!.room).toMatchObject({ phase: 'round', round: 1, myGameId: 'game-host', challengeCode: 'chal0001' });
    d.run({ type: 'start', playerId: 'host' });
    expect(d.errors('host')).toEqual(['room_started']);
  });

  it('no late joins; settings are locked while playing', () => {
    const d = started('bob');
    expect(d.join('late')).toEqual([{ type: 'send', to: 'late', msg: { t: 'error', error: 'room_started' } }]);
    d.run({ type: 'settings', playerId: 'host', settings: settingsFor('party') });
    expect(d.errors('host')).toEqual(['room_started']);
  });

  it('a round ends when everyone guessed; totals add up; host `next` or 15 s advance', () => {
    const d = started('bob', 'carl');
    d.scores = { host: 4000, bob: 2500, carl: 0 };
    d.guess('host');
    expect(d.got('carl', 'guessed')).toEqual([{ t: 'guessed', playerId: 'host' }]);
    d.guess('host'); // duplicate event: ignored
    d.guess('bob');
    expect(d.callsOf('closeRound')).toHaveLength(0);
    d.clock.advance(5000);
    d.guess('carl');
    expect(d.callsOf('closeRound')).toEqual([{ op: 'closeRound', challengeCode: 'chal0001', n: 1 }]);
    const result = d.last('bob', 'roundResult')!;
    expect(result).toMatchObject({ n: 1, answer: { world: 'alpha', x: 0, z: 0 }, nextAt: T0 + 5000 + PARTY_RESULT_MS });
    expect(result.duel).toBeUndefined();
    expect(result.results.map((r) => r.score)).toEqual([4000, 2500, 0]);
    expect(d.last('host', 'room')!.room).toMatchObject({ phase: 'result', round: 1 });
    expect(d.last('host', 'room')!.room.players.map((p) => p.total)).toEqual([4000, 2500, 0]);

    // Auto-advance after 15 s.
    expect(d.machine.nextWakeAt()).toBe(T0 + 5000 + PARTY_RESULT_MS);
    d.tickAt(T0 + 5000 + PARTY_RESULT_MS - 1);
    expect(d.callsOf('openRound')).toHaveLength(1);
    d.run({ type: 'next', playerId: 'bob' });
    expect(d.errors('bob')).toEqual(['not_host']);
    d.tickAt(T0 + 5000 + PARTY_RESULT_MS);
    expect(d.callsOf('openRound').map((c) => c.n)).toEqual([1, 2]);
    expect(d.last('carl', 'round')!.n).toBe(2);
    // Round 2, host skips the result phase with `next`.
    for (const id of ['host', 'bob', 'carl']) d.guess(id);
    d.run({ type: 'next', playerId: 'host' });
    d.run({ type: 'next', playerId: 'host' }); // late double-click: ignored
    expect(d.callsOf('openRound').map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it('timed rounds close at deadline + 2 s grace even if someone did not guess', () => {
    const d = new RoomDriver('party', 'host', settingsFor('party', { timeLimit: 60 }));
    d.join('host');
    d.join('bob');
    d.run({ type: 'start', playerId: 'host' });
    const deadline = T0 + 60_000;
    expect(d.last('bob', 'round')!.deadline).toBe(deadline);
    d.guess('host');
    expect(d.machine.nextWakeAt()).toBe(deadline + DEADLINE_GRACE_MS);
    d.tickAt(deadline + DEADLINE_GRACE_MS - 1);
    expect(d.callsOf('closeRound')).toHaveLength(0);
    d.tickAt(deadline + DEADLINE_GRACE_MS);
    expect(d.callsOf('closeRound')).toHaveLength(1);
    expect(d.machine.publicPhase).toBe('result');
  });

  it('endRound: host only; an untimed round gets a 5 s countdown, then closes with timeouts for the rest', () => {
    const d = started('bob', 'carl');
    expect(d.last('bob', 'round')!.deadline).toBeNull();
    d.scores = { host: 4000, bob: 0, carl: 0 };
    d.guess('host');
    d.run({ type: 'endRound', playerId: 'bob' });
    expect(d.errors('bob')).toEqual(['not_host']);
    d.clock.advance(1000);
    d.run({ type: 'endRound', playerId: 'host' });
    const deadline = d.clock.now + END_ROUND_COUNTDOWN_MS;
    expect(d.callsOf('setDeadline')).toEqual([{ op: 'setDeadline', challengeCode: 'chal0001', n: 1, deadline }]);
    for (const id of ['host', 'bob', 'carl']) expect(d.last(id, 'countdown')).toEqual({ t: 'countdown', deadline });
    expect(d.machine.nextWakeAt()).toBe(deadline + DEADLINE_GRACE_MS);
    // A second press changes nothing.
    d.run({ type: 'endRound', playerId: 'host' });
    expect(d.callsOf('setDeadline')).toHaveLength(1);
    // bob's client submits his placed marker before the deadline; carl never guesses.
    d.guess('bob');
    expect(d.callsOf('closeRound')).toHaveLength(0);
    d.tickAt(deadline + DEADLINE_GRACE_MS);
    expect(d.callsOf('closeRound')).toHaveLength(1);
    expect(d.last('carl', 'roundResult')!.results.find((r) => r.playerId === 'carl')!.score).toBe(0);
    // Outside a round endRound is refused.
    d.run({ type: 'endRound', playerId: 'host' });
    expect(d.errors('host')).toEqual(['round_over']);
  });

  it('endRound keeps an earlier deadline and a reconnecting player gets the countdown', () => {
    const d = new RoomDriver('party', 'host', settingsFor('party', { timeLimit: 30 }));
    d.join('host');
    d.join('bob');
    d.run({ type: 'start', playerId: 'host' });
    const deadline = T0 + 30_000;
    d.tickAt(deadline - 2000);
    d.run({ type: 'endRound', playerId: 'host' });
    expect(d.callsOf('setDeadline')).toHaveLength(0); // 2 s left: nothing to move
    expect(d.last('bob', 'countdown')).toEqual({ t: 'countdown', deadline });
    d.run({ type: 'disconnect', playerId: 'bob' });
    d.clearInbox();
    d.join('bob');
    expect(d.got('bob', 'countdown')).toEqual([{ t: 'countdown', deadline }]);
  });

  it('disconnected players do not hold the round, score 0, and can reconnect into the running game', () => {
    const d = started('bob', 'carl');
    d.scores = { host: 3000, bob: 3000 };
    d.guess('host');
    d.run({ type: 'disconnect', playerId: 'carl' });
    expect(d.last('host', 'room')!.room.players.find((p) => p.id === 'carl')!.connected).toBe(false);
    d.guess('bob');
    expect(d.callsOf('closeRound')).toHaveLength(1); // carl is away: everyone connected has guessed
    expect(d.last('host', 'roundResult')!.results.find((r) => r.playerId === 'carl')!.score).toBe(0);

    // Reconnect during the result phase: full state again.
    d.clearInbox();
    d.join('carl');
    expect(d.attached.has('carl')).toBe(true);
    expect(d.got('carl', 'started')).toEqual([{ t: 'started', gameId: 'game-carl', challengeCode: 'chal0001' }]);
    expect(d.got('carl', 'roundResult')).toHaveLength(1);
    expect(d.last('carl', 'room')!.room).toMatchObject({ phase: 'result', myGameId: 'game-carl' });

    // Disconnect again, reconnect mid-round: gets the round and who already guessed.
    d.run({ type: 'disconnect', playerId: 'carl' });
    d.run({ type: 'next', playerId: 'host' });
    d.guess('bob');
    d.clearInbox();
    d.join('carl');
    expect(d.got('carl', 'round')).toEqual([{ t: 'round', n: 2, node: { key: 'key2', links: [] }, deadline: null, startedAt: T0 }]);
    expect(d.got('carl', 'guessed')).toEqual([{ t: 'guessed', playerId: 'bob' }]);
    d.guess('host');
    expect(d.callsOf('closeRound')).toHaveLength(1); // carl is back and has not guessed
    d.guess('carl');
    expect(d.callsOf('closeRound')).toHaveLength(2);
  });

  it('with nobody connected the round waits for its deadline and the result phase holds', () => {
    const d = new RoomDriver('party', 'host', settingsFor('party', { timeLimit: 30 }));
    d.join('host');
    d.run({ type: 'start', playerId: 'host' });
    d.run({ type: 'disconnect', playerId: 'host' });
    expect(d.callsOf('closeRound')).toHaveLength(0);
    d.tickAt(T0 + 32_000);
    expect(d.machine.publicPhase).toBe('result');
    expect(d.machine.nextWakeAt()).toBe(T0 + ROOM_IDLE_MS); // only the idle expiry
    d.tickAt(T0 + 32_000 + PARTY_RESULT_MS + 1000);
    expect(d.callsOf('openRound')).toHaveLength(1);
    d.join('host');
    d.run({ type: 'tick' });
    expect(d.callsOf('openRound')).toHaveLength(2);
  });

  it('host leaving mid-game hands over at once; the leaver stays in the standings until the game ends', () => {
    const d = started('bob', 'carl');
    d.run({ type: 'leave', playerId: 'host' });
    expect(d.machine.host).toBe('bob');
    expect(d.attached.has('host')).toBe(false);
    expect(d.machine.memberIds()).toEqual(['host', 'bob', 'carl']);
    d.guess('bob');
    d.guess('carl');
    expect(d.callsOf('closeRound')).toHaveLength(1);
    d.run({ type: 'next', playerId: 'bob' });
    expect(d.callsOf('openRound')).toHaveLength(2);
  });

  it('kick during a party game: kicked player is out of the round and cannot rejoin', () => {
    const d = started('bob', 'carl');
    d.guess('host');
    d.guess('bob');
    d.run({ type: 'kick', playerId: 'host', target: 'carl' });
    expect(d.got('carl', 'kicked')).toHaveLength(1);
    expect(d.callsOf('closeRound')).toHaveLength(1);
    d.join('carl');
    expect(d.errors('carl')).toEqual(['forbidden']);
  });

  it('game over after the last round; standings; back to a lobby that can start again', () => {
    const d = started('bob', 'carl');
    const rounds = [
      { host: 1000, bob: 5000, carl: 2000 },
      { host: 1000, bob: 0, carl: 2000 },
      { host: 1000, bob: 1000, carl: 2500 },
    ];
    d.run({ type: 'leave', playerId: 'carl' }); // leaves mid-game: still ranked
    for (const [i, scores] of rounds.entries()) {
      d.scores = scores;
      d.guess('host');
      d.guess('bob');
      expect(d.callsOf('closeRound')).toHaveLength(i + 1);
      if (i < 2) d.run({ type: 'next', playerId: 'host' });
    }
    expect(d.callsOf('finish')).toHaveLength(0);
    d.run({ type: 'next', playerId: 'host' });
    expect(d.callsOf('finish')).toEqual([{ op: 'finish', challengeCode: 'chal0001', roundsPlayed: 3 }]);
    const over = d.last('host', 'gameOver')!;
    expect(over.challengeCode).toBe('chal0001');
    expect(over.winner).toBeUndefined();
    expect(over.reason).toBe('rounds');
    expect(over.standings).toEqual([
      { playerId: 'carl', nickname: 'carl', total: 6500, timeMs: 3000 },
      { playerId: 'bob', nickname: 'bob', total: 6000, timeMs: 3000 },
      { playerId: 'host', nickname: 'host', total: 3000, timeMs: 3000 },
    ]);
    expect(d.machine.memberIds()).toEqual(['host', 'bob']); // carl left during the game
    const room = d.last('bob', 'room')!.room;
    expect(room).toMatchObject({ phase: 'over', round: 0, challengeCode: 'chal0001', myGameId: null });
    expect(room.players.map((p) => p.total)).toEqual([3000, 6000]);

    // A reconnecting member gets the final standings; new players may join; the host starts again.
    d.run({ type: 'disconnect', playerId: 'bob' });
    d.clearInbox();
    d.join('bob');
    expect(d.got('bob', 'gameOver')).toHaveLength(1);
    expect(d.last('bob', 'gameOver')!.reason).toBe('rounds');
    d.join('dave');
    expect(d.machine.memberIds()).toEqual(['host', 'bob', 'dave']);
    d.run({ type: 'start', playerId: 'host' });
    expect(d.callsOf('createGames')[1]!.playerIds).toEqual(['host', 'bob', 'dave']);
    expect(d.last('dave', 'round')!.n).toBe(1);
  });

  it('tie on total is broken by time', () => {
    const d = started('bob');
    d.scores = { host: 2000, bob: 2000 };
    for (let n = 1; n <= 3; n++) {
      d.guess('host');
      d.guess('bob');
      d.run({ type: 'next', playerId: 'host' });
    }
    expect(d.last('host', 'gameOver')!.standings.map((s) => s.playerId)).toEqual(['host', 'bob']); // equal: stable
  });

  it('expires after 30 min without activity and finishes a running game', () => {
    const d = started('bob');
    d.guess('host');
    const idleFrom = d.clock.now;
    expect(d.machine.nextWakeAt()).toBe(idleFrom + ROOM_IDLE_MS);
    d.tickAt(idleFrom + ROOM_IDLE_MS - 1);
    expect(d.closed).toBeNull();
    d.tickAt(idleFrom + ROOM_IDLE_MS);
    expect(d.closed).toBe('expired');
    expect(d.callsOf('finish')).toEqual([{ op: 'finish', challengeCode: 'chal0001', roundsPlayed: 1 }]);
    expect(d.errors('host')).toEqual(['room_closed']);
    expect(d.errors('bob')).toEqual(['room_closed']);
    expect(d.attached.size).toBe(0);
    expect(d.machine.nextWakeAt()).toBeNull();
  });

  it('admin close tells every member room_closed', () => {
    const d = lobby('bob');
    d.run({ type: 'close', reason: 'admin' });
    expect(d.closed).toBe('admin');
    expect(d.errors('bob')).toEqual(['room_closed']);
    expect(d.callsOf('finish')).toHaveLength(0);
  });

  it('a failed createGames returns to the lobby with the error', () => {
    const d = lobby('bob');
    d.autoRespond = false;
    d.run({ type: 'start', playerId: 'host' });
    d.run({ type: 'callFailed', op: 'createGames', error: 'bad_request' });
    expect(d.errors('host')).toEqual(['bad_request']);
    expect(d.machine.publicPhase).toBe('lobby');
    expect(d.machine.gameRunning).toBe(false);
  });

  it('guess events of another challenge or round are ignored', () => {
    const d = started('bob');
    d.run({ type: 'guess', playerId: 'host', n: 1, challengeCode: 'other' });
    d.run({ type: 'guess', playerId: 'host', n: 2, challengeCode: 'chal0001' });
    d.run({ type: 'guess', playerId: 'stranger', n: 1, challengeCode: 'chal0001' });
    expect(d.got('bob', 'guessed')).toHaveLength(0);
  });

  it('adminView lists players and phase', () => {
    const d = lobby('bob');
    expect(d.machine.adminView()).toEqual({
      code: 'ABCDE',
      type: 'party',
      phase: 'lobby',
      players: [
        { id: 'host', nickname: 'host', connected: true },
        { id: 'bob', nickname: 'bob', connected: true },
      ],
      createdAt: T0,
      lastActivityAt: T0,
    });
    expect(new RoomMachine(
      { code: 'X', type: 'party', settings: settingsFor('party'), hostId: 'h', hostNickname: 'h' },
      { clock: () => 5, parseSettings: () => settingsFor('party') },
    ).createdAt).toBe(5);
  });
});
