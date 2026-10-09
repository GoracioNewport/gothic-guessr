/**
 * The service container handed to every route module and plugin (rooms, admin). Built once in main.ts (or per test).
 *
 *   services.games     GameService — games, rounds, challenges, daily, leaderboards, and the room API (core/games.ts)
 *   services.players   PlayerService — create/authenticate/rename (core/players.ts)
 *   services.repo      Repository (SQLite; `services.repo.db` for admin read queries)
 *   services.worlds    WorldRegistry (private manifests, read-only)
 *   services.limits    in-memory rate limiters (core/ratelimit.ts)
 *   services.clock     epoch-ms clock (injected in tests)
 *   services.config    Config (secrets: never send to clients or logs)
 */
import type { Config } from './config';
import { Emitter } from './core/events';
import { GameService } from './core/games';
import type { GameEvents } from './core/games';
import { PlayerService } from './core/players';
import { RateLimits } from './core/ratelimit';
import type { WorldRegistry } from './core/worlds';
import type { SqliteRepository } from './db/repository';

export interface Services {
  config: Config;
  repo: SqliteRepository;
  worlds: WorldRegistry;
  clock: () => number;
  games: GameService;
  players: PlayerService;
  limits: RateLimits;
  events: Emitter<GameEvents>;
}

export function createServices(opts: {
  config: Config;
  repo: SqliteRepository;
  worlds: WorldRegistry;
  clock?: () => number;
  limits?: RateLimits;
}): Services {
  const clock = opts.clock ?? Date.now;
  const events = new Emitter<GameEvents>((err, type) => console.error(`[events] ${String(type)} listener failed:`, err));
  return {
    config: opts.config,
    repo: opts.repo,
    worlds: opts.worlds,
    clock,
    events,
    games: new GameService({ repo: opts.repo, worlds: opts.worlds, clock, secret: opts.config.serverSecret, events }),
    players: new PlayerService(opts.repo, clock),
    limits: opts.limits ?? new RateLimits(),
  };
}
