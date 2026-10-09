/**
 * Game sessions: the seam between the game UI (src/play/flow.ts) and whoever drives the rounds.
 *
 * - {@link GameDriver} is what the UI needs from a game: the next round, nodes, guesses, the summary.
 * - {@link RestGameSession} drives a solo, daily or challenge game entirely over REST (SPEC §10.4): the client
 *   opens each round itself.
 * - A room game (SPEC §10.6) is driven by the room's WebSocket instead: the rooms module implements `nextRound`
 *   by waiting for the server's `round` message and reuses `node`/`guess` over REST with the player's game id
 *   (subclass RestGameSession and override `nextRound`).
 *
 * Reload safety (SPEC §10.7): the running game's id and the page it runs on are kept in `sessionStorage`
 * ({@link STORED_GAME_KEY}); a reload of that page resumes it from `GET /games/:id`.
 */
import type { GameSummaryView, GameView, PanoNode, RoundResultView, RoundView, WorldGuess } from '../../shared/api';
import type { ApiClient } from '../net/api';

export interface GameDriver {
  /** The latest server view of the game (refreshed after every call that changes it). */
  readonly view: GameView;
  /** Start the next round, or return the open one. */
  nextRound(): Promise<RoundView>;
  /** One node of the open round (reach-checked by the server). */
  node(key: string): Promise<PanoNode>;
  /** Submit the guess of the open round; `null` = gave up / timer expired. */
  guess(guess: WorldGuess | null): Promise<RoundResultView>;
  /** Re-read the game from the server. */
  refresh(): Promise<GameView>;
  /** Summary with leaderboard (finished games only). */
  summary(): Promise<GameSummaryView>;
}

export class RestGameSession implements GameDriver {
  protected readonly api: ApiClient;
  private current: GameView;

  constructor(api: ApiClient, view: GameView) {
    this.api = api;
    this.current = view;
  }

  get view(): GameView {
    return this.current;
  }

  get id(): string {
    return this.current.id;
  }

  async nextRound(): Promise<RoundView> {
    if (this.current.current) return this.current.current;
    const round = await this.api.openRound(this.id);
    this.current = { ...this.current, current: round, currentKey: round.start.key };
    return round;
  }

  node(key: string): Promise<PanoNode> {
    return this.api.getNode(this.id, key);
  }

  async guess(guess: WorldGuess | null): Promise<RoundResultView> {
    const result = await this.api.guess(this.id, guess);
    const results = [...this.current.results.filter((r) => r.n !== result.n), result].sort((a, b) => a.n - b.n);
    const total = results.reduce((s, r) => s + r.score, 0);
    this.current = {
      ...this.current,
      results,
      total,
      current: null,
      currentKey: null,
      finished: results.length >= this.current.totalRounds,
    };
    return result;
  }

  async refresh(): Promise<GameView> {
    this.current = await this.api.getGame(this.id);
    return this.current;
  }

  summary(): Promise<GameSummaryView> {
    return this.api.summary(this.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Stored running game (sessionStorage)
// ---------------------------------------------------------------------------------------------

export const STORED_GAME_KEY = 'gothic2guessr.game';

export interface StoredGame {
  id: string;
  /** Pathname the game runs on (`/play`, `/daily`, `/c/<code>`). */
  path: string;
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): SessionStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredGame(store: SessionStore | null = sessionStore()): StoredGame | null {
  try {
    const raw = store?.getItem(STORED_GAME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredGame>;
    return typeof v.id === 'string' && typeof v.path === 'string' ? { id: v.id, path: v.path } : null;
  } catch {
    return null;
  }
}

export function writeStoredGame(game: StoredGame, store: SessionStore | null = sessionStore()): void {
  try {
    store?.setItem(STORED_GAME_KEY, JSON.stringify(game));
  } catch {
    /* no reload safety without storage */
  }
}

export function clearStoredGame(store: SessionStore | null = sessionStore()): void {
  try {
    store?.removeItem(STORED_GAME_KEY);
  } catch {
    /* ignore */
  }
}
