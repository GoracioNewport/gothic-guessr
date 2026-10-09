/**
 * Test driver for the pure room state machine (server/core/party.ts): runs effects like the registry does, answering
 * service calls with fabricated results (scores set per player by the test), and records what each player received.
 */
import type { PublicSettings, RoomType, ServerMessage } from '../../shared/api';
import { RoomMachine } from '../../server/core/party';
import type { RoomCall, RoomEffect, RoomEvent } from '../../server/core/party';
import { parseSettings } from '../../server/core/settings';
import { FakeClock } from './helpers';

export const WORLDS = ['alpha', 'beta'];

export function settingsFor(type: RoomType, extra: Partial<PublicSettings> = {}): PublicSettings {
  return parseSettings({ mode: 'classic', worlds: WORLDS, timeLimit: 0, rounds: 3, ...extra }, WORLDS, type);
}

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

export class RoomDriver {
  readonly clock = new FakeClock();
  readonly machine: RoomMachine;
  readonly inbox = new Map<string, ServerMessage[]>();
  readonly calls: RoomCall[] = [];
  readonly attached = new Set<string>();
  closed: string | null = null;
  /** Round score per player used when a round closes (missing → 0). */
  scores: Record<string, number> = {};
  /** Picks the fake createGames reports (duel cap). */
  duelRounds = 30;
  /** When false, calls are recorded but not answered. */
  autoRespond = true;

  constructor(type: RoomType, host = 'host', settings: PublicSettings = settingsFor(type)) {
    this.machine = new RoomMachine(
      { code: 'ABCDE', type, settings, hostId: host, hostNickname: host },
      { clock: this.clock.fn, parseSettings: (raw, t) => parseSettings(raw, WORLDS, t) },
    );
  }

  /** Feed an event and run every effect (including call results) to completion. */
  run(ev: RoomEvent): RoomEffect[] {
    const all: RoomEffect[] = [];
    const queue: RoomEvent[] = [ev];
    while (queue.length > 0) {
      const effects = this.machine.handle(queue.shift()!);
      all.push(...effects);
      for (const e of effects) {
        if (e.type === 'send') {
          const list = this.inbox.get(e.to) ?? [];
          list.push(e.msg);
          this.inbox.set(e.to, list);
        } else if (e.type === 'attach') this.attached.add(e.playerId);
        else if (e.type === 'detach') this.attached.delete(e.playerId);
        else if (e.type === 'closed') this.closed = e.reason;
        else if (e.type === 'call') {
          this.calls.push(e.call);
          const result = this.autoRespond ? this.answer(e.call) : null;
          if (result) queue.push(result);
        }
      }
    }
    return all;
  }

  answer(call: RoomCall): RoomEvent | null {
    switch (call.op) {
      case 'createGames':
        return {
          type: 'gamesCreated',
          challengeCode: 'chal0001',
          games: Object.fromEntries(call.playerIds.map((p) => [p, `game-${p}`])),
          rounds: call.type === 'duel' ? this.duelRounds : call.settings.rounds,
          settings: call.settings,
        };
      case 'openRound':
        return { type: 'roundOpened', n: call.n, node: { key: `key${call.n}`, links: [] } };
      case 'setDeadline':
        return null;
      case 'closeRound': {
        const players = this.machine.memberIds();
        const ids = new Set([...players, ...Object.keys(this.scores)]);
        return {
          type: 'roundClosed',
          n: call.n,
          answer: { world: 'alpha', x: 0, z: 0 },
          results: [...ids].map((id) => ({ playerId: id, guess: null, distanceM: null, score: this.scores[id] ?? 0, timeMs: 1000 })),
        };
      }
      case 'finish':
        return { type: 'finished' };
    }
  }

  join(id: string): RoomEffect[] {
    return this.run({ type: 'join', playerId: id, nickname: id });
  }

  guess(id: string, n = this.machine.view(null).round): RoomEffect[] {
    return this.run({ type: 'guess', playerId: id, n, challengeCode: 'chal0001' });
  }

  tickAt(ms: number): RoomEffect[] {
    this.clock.now = ms;
    return this.run({ type: 'tick' });
  }

  /** Messages a player got, optionally only of one kind. */
  got<T extends ServerMessage['t']>(id: string, t: T): Msg<T>[] {
    return (this.inbox.get(id) ?? []).filter((m): m is Msg<T> => m.t === t);
  }

  last<T extends ServerMessage['t']>(id: string, t: T): Msg<T> | undefined {
    const list = this.got(id, t);
    return list[list.length - 1];
  }

  errors(id: string): string[] {
    return this.got(id, 'error').map((m) => m.error);
  }

  clearInbox(): void {
    this.inbox.clear();
  }

  callsOf<O extends RoomCall['op']>(op: O): Extract<RoomCall, { op: O }>[] {
    return this.calls.filter((c): c is Extract<RoomCall, { op: O }> => c.op === op);
  }
}
