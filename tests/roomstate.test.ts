import { describe, expect, it } from 'vitest';
import type { PublicSettings, RoomPlayer, RoomView, ServerMessage, Standing } from '../shared/api';
import { DUEL_ROUND_CAP, inviteLink, settingsForType, switchType } from '../src/ui/lobby';
import {
  DUEL_START_HP,
  PLAYER_COLORS,
  duelOutcome,
  duelSides,
  errorSeverity,
  hpRatio,
  hpWidth,
  initialRoomState,
  isHost,
  nicknames,
  playerColors,
  reduceRoom,
  roomScreen,
  roundRows,
  secondsUntil,
  sharedRanks,
  standingRows,
  startBlock,
} from '../src/ui/roomstate';
import type { RoomState } from '../src/ui/roomstate';
import { roomExtraLines } from '../src/ui/roomrules';
import { ruleLines } from '../src/ui/rulespanel';

const SETTINGS: PublicSettings = { mode: 'mixed', worlds: ['khorinis'], noMove: false, noLook: false, timeLimit: 120, rounds: 3 };

function player(id: string, extra: Partial<RoomPlayer> = {}): RoomPlayer {
  return { id, nickname: id.toUpperCase(), host: false, connected: true, guessed: false, total: 0, ...extra };
}

function room(extra: Partial<RoomView> = {}): RoomView {
  return {
    code: 'ABCDE',
    type: 'party',
    phase: 'lobby',
    settings: SETTINGS,
    players: [player('a', { host: true }), player('b'), player('c')],
    capacity: 16,
    round: 0,
    challengeCode: null,
    myGameId: null,
    ...extra,
  };
}

function run(msgs: ServerMessage[], start: RoomState = initialRoomState()): RoomState {
  return msgs.reduce(reduceRoom, start);
}

const node = { key: 'k1', links: [] };

describe('reduceRoom', () => {
  it('lobby: room messages update the view, no game', () => {
    const s = run([{ t: 'room', room: room() }]);
    expect(s.room?.code).toBe('ABCDE');
    expect(roomScreen(s)).toBe('lobby');
    expect(roomScreen(initialRoomState())).toBe('loading');
  });

  it('a party game: started → round → guessed → result → next round → game over', () => {
    let s = run([
      { t: 'room', room: room() },
      { t: 'started', gameId: 'g1', challengeCode: 'ch1' },
    ]);
    expect(s.gameId).toBe('g1');
    expect(s.challengeCode).toBe('ch1');
    // Game running, round not here yet: no lobby flash.
    s = reduceRoom(s, { t: 'room', room: room({ phase: 'round', round: 1, myGameId: 'g1' }) });
    expect(roomScreen(s)).toBe('loading');
    s = run(
      [
        { t: 'round', n: 1, node, deadline: 1000, startedAt: 0 },
        { t: 'guessed', playerId: 'b' },
        { t: 'guessed', playerId: 'b' },
        { t: 'guessed', playerId: 'a' },
      ],
      s,
    );
    expect(roomScreen(s)).toBe('round');
    expect(s.guessed).toEqual(['b', 'a']);
    const result: ServerMessage = {
      t: 'roundResult',
      n: 1,
      answer: { world: 'khorinis', x: 0, z: 0 },
      results: [
        { playerId: 'a', guess: { world: 'khorinis', x: 1, z: 1 }, distanceM: 1, score: 4900, timeMs: 5000 },
        { playerId: 'b', guess: null, distanceM: null, score: 0, timeMs: 120000 },
      ],
      nextAt: 15000,
    };
    s = reduceRoom(s, result);
    expect(roomScreen(s)).toBe('result');
    // A late guessed tick for the closed round is ignored.
    expect(reduceRoom(s, { t: 'guessed', playerId: 'c' }).guessed).toEqual(['b', 'a']);
    s = reduceRoom(s, { t: 'round', n: 2, node: { key: 'k2', links: [] }, deadline: null, startedAt: 20000 });
    expect(roomScreen(s)).toBe('round');
    expect(s.guessed).toEqual([]);
    expect(s.result).toBeNull();
    s = run(
      [
        { t: 'gameOver', standings: [{ playerId: 'a', nickname: 'A', total: 4900, timeMs: 5000 }], challengeCode: 'ch1' },
        { t: 'room', room: room({ phase: 'over', challengeCode: 'ch1' }) },
      ],
      s,
    );
    expect(s.gameId).toBeNull();
    expect(roomScreen(s)).toBe('over');
    expect(s.challengeCode).toBe('ch1');
  });

  it('a reconnect re-sends the same round: guessed ticks are kept and the duel countdown wins over the base deadline', () => {
    let s = run([
      { t: 'started', gameId: 'g1', challengeCode: 'ch' },
      { t: 'round', n: 3, node, deadline: 300000, startedAt: 0, duel: { hp: { a: 6000, b: 5000 }, multiplier: 1 } },
      { t: 'guessed', playerId: 'a' },
      { t: 'countdown', deadline: 20000 },
    ]);
    expect(s.round?.deadline).toBe(20000);
    s = run(
      [
        { t: 'started', gameId: 'g1', challengeCode: 'ch' },
        { t: 'round', n: 3, node, deadline: 300000, startedAt: 0, duel: { hp: { a: 6000, b: 5000 }, multiplier: 1 } },
      ],
      s,
    );
    expect(s.guessed).toEqual(['a']);
    expect(s.round?.deadline).toBe(20000);
    expect(s.countdown).toBe(20000);
  });

  it('remembers the HP before a duel result for the damage animation', () => {
    const s = run([
      { t: 'room', room: room({ type: 'duel', phase: 'round', round: 1, myGameId: 'g1' }) },
      { t: 'started', gameId: 'g1', challengeCode: 'ch' },
      { t: 'round', n: 1, node, deadline: 300000, startedAt: 0, duel: { hp: { a: 6000, b: 6000 }, multiplier: 1 } },
      {
        t: 'roundResult',
        n: 1,
        answer: { world: 'khorinis', x: 0, z: 0 },
        results: [],
        duel: { hp: { a: 6000, b: 3500 }, multiplier: 1, damage: { a: 0, b: 2500 } },
      },
    ]);
    expect(s.hpBefore).toEqual({ a: 6000, b: 6000 });
    expect(roomScreen(s)).toBe('result');
  });

  it('a result received without its round (reconnect in the result phase) still shows the result', () => {
    const s = run([
      { t: 'room', room: room({ phase: 'result', round: 4, myGameId: 'g1' }) },
      { t: 'started', gameId: 'g1', challengeCode: 'ch' },
      { t: 'roundResult', n: 4, answer: { world: 'valley', x: 0, z: 0 }, results: [] },
    ]);
    expect(s.round?.n).toBe(4);
    expect(roomScreen(s)).toBe('result');
  });

  it('kicked and errors', () => {
    let s = run([{ t: 'error', error: 'room_full' }]);
    expect(s.error).toBe('room_full');
    expect(s.errorSeq).toBe(1);
    s = run([{ t: 'error', error: 'room_full' }], s);
    expect(s.errorSeq).toBe(2);
    s = run([{ t: 'room', room: room() }, { t: 'kicked' }], s);
    expect(roomScreen(s)).toBe('kicked');
  });

  it('a new game after game over clears the old one', () => {
    const s = run([
      { t: 'gameOver', standings: [], challengeCode: 'old' },
      { t: 'started', gameId: 'g2', challengeCode: 'new' },
    ]);
    expect(s.gameOver).toBeNull();
    expect(s.challengeCode).toBe('new');
  });
});

describe('errorSeverity', () => {
  it('classifies room errors', () => {
    const fresh = { awaitingStart: false, joined: false };
    const joined = { awaitingStart: false, joined: true };
    expect(errorSeverity('room_full', fresh)).toBe('fatal');
    expect(errorSeverity('room_started', fresh)).toBe('fatal');
    expect(errorSeverity('room_closed', joined)).toBe('fatal');
    expect(errorSeverity('banned', joined)).toBe('fatal');
    expect(errorSeverity('not_found', fresh)).toBe('fatal');
    expect(errorSeverity('not_found', joined)).toBe('toast');
    expect(errorSeverity('forbidden', fresh)).toBe('fatal');
    expect(errorSeverity('forbidden', joined)).toBe('toast');
    expect(errorSeverity('conflict', joined)).toBe('replaced');
    expect(errorSeverity('conflict', { awaitingStart: true, joined: true })).toBe('toast');
    expect(errorSeverity('not_host', joined)).toBe('toast');
    expect(errorSeverity('rate_limited', joined)).toBe('toast');
  });
});

describe('colours', () => {
  it('gives every player of a full room its own colour, stable by room order', () => {
    const players = Array.from({ length: 16 }, (_, i) => player(`p${i}`));
    const colors = playerColors(players);
    expect(new Set(colors.values()).size).toBe(16);
    expect(colors.get('p0')).toBe(PLAYER_COLORS[0]);
    expect(playerColors(players.slice(3)).get('p3')).toBe(PLAYER_COLORS[0]);
    // Players who already left (standings only) get the next colours.
    expect(playerColors([player('a')], ['a', 'gone']).get('gone')).toBe(PLAYER_COLORS[1]);
  });

  it('avoids the own-guess blue and the answer gold, and every colour is a valid hex', () => {
    for (const c of PLAYER_COLORS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(['#2f80ed', '#f2c14e']).not.toContain(c);
    }
  });
});

describe('HP bar math', () => {
  it('clamps the ratio to [0, 1]', () => {
    expect(hpRatio(DUEL_START_HP)).toBe(1);
    expect(hpRatio(3000)).toBe(0.5);
    expect(hpRatio(0)).toBe(0);
    expect(hpRatio(-50)).toBe(0);
    expect(hpRatio(9000)).toBe(1);
    expect(hpRatio(Number.NaN)).toBe(0);
    expect(hpRatio(10, 0)).toBe(0);
    expect(hpWidth(2250)).toBe('37.50%');
    expect(hpWidth(1, 3)).toBe('33.33%');
  });

  it('puts this player first', () => {
    const names = new Map([
      ['a', 'Ann'],
      ['b', 'Bob'],
    ]);
    expect(duelSides({ a: 100, b: 200 }, 'b', names)).toEqual([
      { id: 'b', name: 'Bob', hp: 200, me: true },
      { id: 'a', name: 'Ann', hp: 100, me: false },
    ]);
    expect(duelSides({ a: 100, x: 5 }, null, names).map((s) => s.name)).toEqual(['Ann', '?']);
  });
});

describe('round table and standings', () => {
  const names = new Map([
    ['a', 'Ann'],
    ['b', 'Bob'],
    ['c', 'Cid'],
  ]);

  it('sorts by score then time and shares ranks on full ties', () => {
    const rows = roundRows(
      {
        t: 'roundResult',
        n: 1,
        answer: { world: 'khorinis', x: 0, z: 0 },
        results: [
          { playerId: 'a', guess: { world: 'valley', x: 0, z: 0 }, distanceM: null, score: 0, timeMs: 3000 },
          { playerId: 'b', guess: { world: 'khorinis', x: 5, z: 5 }, distanceM: 7, score: 4000, timeMs: 9000 },
          { playerId: 'c', guess: { world: 'khorinis', x: 5, z: 5 }, distanceM: 7, score: 4000, timeMs: 9000 },
        ],
      },
      'a',
      names,
    );
    expect(rows.map((r) => [r.rank, r.name])).toEqual([
      [1, 'Bob'],
      [1, 'Cid'],
      [3, 'Ann'],
    ]);
    expect(rows[2]).toMatchObject({ me: true, wrongWorld: true, distanceM: null });
    expect(rows[0]!.damage).toBeUndefined();
  });

  it('adds duel damage and HP', () => {
    const rows = roundRows(
      {
        t: 'roundResult',
        n: 5,
        answer: { world: 'khorinis', x: 0, z: 0 },
        results: [
          { playerId: 'a', guess: null, distanceM: null, score: 0, timeMs: 15000 },
          { playerId: 'b', guess: { world: 'khorinis', x: 1, z: 1 }, distanceM: 1, score: 3000, timeMs: 2000 },
        ],
        duel: { hp: { a: 0, b: 6000 }, multiplier: 2, damage: { a: 6000, b: 0 } },
      },
      'a',
      names,
    );
    expect(rows.map((r) => [r.playerId, r.damage, r.hp])).toEqual([
      ['b', 0, 6000],
      ['a', 6000, 0],
    ]);
  });

  it('sharedRanks', () => {
    expect(sharedRanks([5, 4, 4, 3, 3, 3, 1], (x, y) => x === y)).toEqual([1, 2, 2, 4, 4, 4, 7]);
    expect(sharedRanks([], () => true)).toEqual([]);
  });

  it('party standings: ranks with ties, a single winner highlighted', () => {
    const st: Standing[] = [
      { playerId: 'a', nickname: 'Ann', total: 9000, timeMs: 10 },
      { playerId: 'b', nickname: 'Bob', total: 8000, timeMs: 10 },
      { playerId: 'c', nickname: 'Cid', total: 8000, timeMs: 10 },
    ];
    const rows = standingRows(st, 'c', undefined);
    expect(rows.map((r) => [r.rank, r.winner, r.me])).toEqual([
      [1, true, false],
      [2, false, false],
      [2, false, true],
    ]);
    // A tie at the top: nobody is "the" winner.
    const tie = standingRows([st[1]!, st[2]!], null, undefined);
    expect(tie.map((r) => [r.rank, r.winner])).toEqual([
      [1, false],
      [1, false],
    ]);
  });

  it('duel standings: winner first, draw = both first', () => {
    const st: Standing[] = [
      { playerId: 'b', nickname: 'Bob', total: 100, timeMs: 1, hp: 2000 },
      { playerId: 'a', nickname: 'Ann', total: 9000, timeMs: 1, hp: 0 },
    ];
    expect(standingRows(st, 'a', 'b').map((r) => [r.playerId, r.rank, r.winner])).toEqual([
      ['b', 1, true],
      ['a', 2, false],
    ]);
    expect(standingRows(st, 'a', null).map((r) => r.rank)).toEqual([1, 1]);
  });
});

describe('duelOutcome', () => {
  const standings: Standing[] = [
    { playerId: 'a', nickname: 'Ann', total: 9000, timeMs: 1, hp: 3000 },
    { playerId: 'b', nickname: 'Bob', total: 100, timeMs: 1, hp: 0 },
  ];
  const duelRoom = room({ type: 'duel', capacity: 2, players: [player('a', { host: true }), player('b')], phase: 'over' });

  it('KO, forfeit, round cap, draw and party', () => {
    expect(duelOutcome({ t: 'gameOver', standings, winner: 'a', challengeCode: 'c' }, 'a', duelRoom)).toEqual({
      kind: 'win',
      winner: 'a',
      loser: 'b',
      reason: 'ko',
    });
    const alive: Standing[] = [standings[0]!, { ...standings[1]!, hp: 1500 }];
    expect(duelOutcome({ t: 'gameOver', standings: alive, winner: 'a', challengeCode: 'c' }, 'b', duelRoom)).toMatchObject({
      kind: 'lose',
      reason: 'rounds',
    });
    const away = room({ type: 'duel', players: [player('a', { host: true }), player('b', { connected: false })] });
    expect(duelOutcome({ t: 'gameOver', standings: alive, winner: 'a', challengeCode: 'c' }, 'b', away)).toMatchObject({ reason: 'forfeit' });
    const left = room({ type: 'duel', players: [player('a', { host: true })] });
    expect(duelOutcome({ t: 'gameOver', standings: alive, winner: 'a', challengeCode: 'c' }, 'x', left)).toMatchObject({
      kind: 'watch',
      reason: 'forfeit',
    });
    expect(duelOutcome({ t: 'gameOver', standings, winner: null, challengeCode: 'c' }, 'a', duelRoom)).toEqual({ kind: 'draw' });
    expect(duelOutcome({ t: 'gameOver', standings, challengeCode: 'c' }, 'a', duelRoom)).toBeNull();
  });
  it("the server's reason wins over inference", () => {
    const alive: Standing[] = [standings[0]!, { ...standings[1]!, hp: 1500 }];
    // The loser is disconnected after the game, but the match ended on the round cap.
    const away = room({ type: 'duel', players: [player('a', { host: true }), player('b', { connected: false })] });
    expect(duelOutcome({ t: 'gameOver', standings: alive, winner: 'a', challengeCode: 'c', reason: 'cap' }, 'a', away)).toMatchObject({ reason: 'rounds' });
    // A forfeit with HP left on both sides while both are still connected.
    expect(duelOutcome({ t: 'gameOver', standings: alive, winner: 'a', challengeCode: 'c', reason: 'forfeit' }, 'b', duelRoom)).toMatchObject({
      kind: 'lose',
      reason: 'forfeit',
    });
    expect(duelOutcome({ t: 'gameOver', standings, winner: 'a', challengeCode: 'c', reason: 'ko' }, 'a', duelRoom)).toMatchObject({ reason: 'ko' });
  });
});

describe('lobby rules', () => {
  it('only the host may start; a duel needs exactly two connected players; a party at least one', () => {
    expect(startBlock(room(), 'b')).toBe('notHost');
    expect(startBlock(room(), null)).toBe('notHost');
    expect(startBlock(room(), 'a')).toBeNull();
    expect(startBlock(room({ phase: 'round' }), 'a')).toBe('started');
    expect(startBlock(room({ phase: 'over' }), 'a')).toBeNull();
    const duel = room({ type: 'duel', players: [player('a', { host: true })] });
    expect(startBlock(duel, 'a')).toBe('needTwo');
    expect(startBlock({ ...duel, players: [player('a', { host: true }), player('b', { connected: false })] }, 'a')).toBe('needTwo');
    expect(startBlock({ ...duel, players: [player('a', { host: true }), player('b')] }, 'a')).toBeNull();
    expect(startBlock(room({ players: [player('a', { host: true, connected: false })] }), 'a')).toBe('noPlayers');
    expect(isHost(room(), 'a')).toBe(true);
    expect(isHost(room(), 'b')).toBe(false);
    expect(isHost(null, 'a')).toBe(false);
  });

  it('settings follow the room type', () => {
    expect(settingsForType('duel', SETTINGS).rounds).toBe(DUEL_ROUND_CAP);
    expect(settingsForType('party', { ...SETTINGS, rounds: DUEL_ROUND_CAP }).rounds).toBe(5);
    expect(settingsForType('party', { ...SETTINGS, rounds: 10 }).rounds).toBe(10);
  });

  it('switching the room type in the lobby takes the new type\'s default time limit', () => {
    const party = { ...SETTINGS, timeLimit: 120, rounds: 3 };
    const duel = switchType('party', 'duel', party);
    expect(duel).toMatchObject({ timeLimit: 0, rounds: DUEL_ROUND_CAP, mode: SETTINGS.mode, worlds: SETTINGS.worlds });
    expect(switchType('duel', 'party', { ...duel, timeLimit: 60 })).toMatchObject({ timeLimit: 120, rounds: 5 });
    // Same type: only the round rule applies, the host's time limit stays.
    expect(switchType('party', 'party', { ...party, timeLimit: 30 })).toMatchObject({ timeLimit: 30, rounds: 3 });
  });

  it('the lobby rules add room-only lines after lines the shared panel has', () => {
    for (const type of ['party', 'duel'] as const) {
      const ids = ruleLines(SETTINGS, { kind: type }).map((l) => l.id);
      for (const extra of roomExtraLines(type)) {
        expect(extra.after === null || ids.includes(extra.after), `${type} ${extra.id} after ${extra.after}`).toBe(true);
        expect(extra.text).not.toMatch(/^roomRules\./);
        ids.push(extra.id);
      }
    }
    expect(roomExtraLines('party')[0]!.text).toContain('16');
    expect(roomExtraLines('duel').map((l) => l.id)).toEqual(['room.duel.players', 'room.duel.leave']);
  });

  it('invite link and nicknames', () => {
    expect(inviteLink('abcde', 'https://g2.example')).toBe('https://g2.example/r/ABCDE');
    const names = nicknames(room(), [{ playerId: 'gone', nickname: 'Ghost', total: 0, timeMs: 0 }]);
    expect(names.get('a')).toBe('A');
    expect(names.get('gone')).toBe('Ghost');
    expect(secondsUntil(10_001, 0)).toBe(11);
    expect(secondsUntil(0, 5000)).toBe(0);
  });
});
