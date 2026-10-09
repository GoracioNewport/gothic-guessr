/**
 * Typed REST client over shared/api.ts (SPEC §10.4).
 *
 * - Identity: the device token lives in `localStorage['gothic2guessr.token']` and goes out as
 *   `Authorization: Bearer <token>`. A call that needs a player creates one first when there is no token, and on
 *   401 `auth` (token unknown to the server, e.g. a wiped database) it creates a new player and retries once.
 *   Concurrent calls share one creation. Calls where the player is optional (challenges, daily, leaderboards)
 *   send the token when there is one and never create a player.
 * - Errors: every non-2xx response becomes an {@link ApiRequestError} with the server's `ApiErrorCode`; a
 *   transport failure becomes code `network`. The UI localizes `code` with `errorMessage()` from src/i18n.
 * - Server clock: the `Date` header of every response feeds {@link ApiClient.serverNow}, used for round
 *   countdowns (deadlines are server epoch ms).
 *
 * `fetch` and storage are injectable for tests.
 */
import type {
  ApiErrorCode,
  ChallengeView,
  CreateGameRequest,
  CreatePlayerResponse,
  GameSummaryView,
  GameView,
  GuessRequest,
  LeaderboardView,
  PanoNode,
  PlayerView,
  RoundResultView,
  RoundView,
  WorldGuess,
} from '../../shared/api';
import { getLanguage } from '../i18n';

export const TOKEN_KEY = 'gothic2guessr.token';

/** Client-side error codes on top of the server's. */
export type ClientErrorCode = ApiErrorCode | 'network';

export class ApiRequestError extends Error {
  readonly code: ClientErrorCode;
  /** HTTP status, 0 for a network failure. */
  readonly status: number;
  /** Seconds from `Retry-After` on 429, if any. */
  readonly retryAfterS: number | null;

  constructor(code: ClientErrorCode, status: number, message?: string, retryAfterS: number | null = null) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
}

/** True when `err` is an API error with one of `codes`. */
export function isApiError(err: unknown, ...codes: ClientErrorCode[]): err is ApiRequestError {
  return err instanceof ApiRequestError && (codes.length === 0 || codes.includes(err.code));
}

/** Minimal storage the client needs (localStorage-compatible). */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ApiClientOptions {
  /** Base URL of the API, default `/api` (`VITE_API_BASE`). */
  base?: string;
  fetch?: typeof fetch;
  storage?: TokenStorage | null;
  /** Local clock, default Date.now (tests). */
  now?: () => number;
  /** Wait before a retried 429 (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

type Auth = 'required' | 'optional' | 'none';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  auth?: Auth;
}

/** Longest `Retry-After` a GET waits out once before giving up, seconds. */
const MAX_AUTO_RETRY_S = 2;

const ERROR_CODES: readonly string[] = [
  'auth', 'not_found', 'forbidden', 'banned', 'rate_limited', 'nickname_rejected', 'already_played', 'room_full',
  'room_started', 'room_closed', 'not_host', 'bad_request', 'round_over', 'conflict', 'internal',
];

function safeStorage(): TokenStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultBase(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_API_BASE ?? '/api').replace(/\/+$/, '');
}

export class ApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: TokenStorage | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Token kept in memory too, so a browser without storage still works for the page's lifetime. */
  private token: string | null;
  private creating: Promise<string> | null = null;
  /** Estimated server clock minus local clock, ms (0 while the clocks agree within a second). */
  private clockOffset = 0;
  private readonly playerListeners = new Set<(p: PlayerView) => void>();

  constructor(options: ApiClientOptions = {}) {
    this.base = (options.base ?? defaultBase()).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = this.readToken();
  }

  // --- identity ------------------------------------------------------------------------------

  /** The stored device token, or null. */
  getToken(): string | null {
    return this.token ?? this.readToken();
  }

  /** Subscribe to player changes (creation, nickname); returns an unsubscribe function. */
  onPlayer(fn: (p: PlayerView) => void): () => void {
    this.playerListeners.add(fn);
    return () => this.playerListeners.delete(fn);
  }

  /** Create a new anonymous player and store its token (concurrent callers share one request). */
  createPlayer(): Promise<string> {
    if (!this.creating) {
      this.creating = this.raw<CreatePlayerResponse>('/players', { method: 'POST', auth: 'none', body: { lang: getLanguage() } })
        .then((res) => {
          this.setToken(res.token);
          this.emitPlayer(res.player);
          return res.token;
        })
        .finally(() => {
          this.creating = null;
        });
    }
    return this.creating;
  }

  /** Current server time estimate, epoch ms. */
  serverNow(): number {
    return this.now() + this.clockOffset;
  }

  // --- endpoints -----------------------------------------------------------------------------

  async me(): Promise<PlayerView> {
    const player = await this.request<PlayerView>('/me');
    this.emitPlayer(player);
    return player;
  }

  async updateNickname(nickname: string): Promise<PlayerView> {
    const player = await this.request<PlayerView>('/me', { method: 'PATCH', body: { nickname } });
    this.emitPlayer(player);
    return player;
  }

  createGame(req: CreateGameRequest): Promise<GameView> {
    return this.request<GameView>('/games', { method: 'POST', body: req });
  }

  getGame(id: string): Promise<GameView> {
    return this.request<GameView>(`/games/${enc(id)}`);
  }

  openRound(id: string): Promise<RoundView> {
    return this.request<RoundView>(`/games/${enc(id)}/rounds`, { method: 'POST' });
  }

  getNode(id: string, key: string): Promise<PanoNode> {
    return this.request<PanoNode>(`/games/${enc(id)}/nodes/${enc(key)}`);
  }

  guess(id: string, guess: WorldGuess | null): Promise<RoundResultView> {
    const body: GuessRequest = { guess };
    return this.request<RoundResultView>(`/games/${enc(id)}/guess`, { method: 'POST', body });
  }

  summary(id: string): Promise<GameSummaryView> {
    return this.request<GameSummaryView>(`/games/${enc(id)}/summary`);
  }

  challenge(code: string): Promise<ChallengeView> {
    return this.request<ChallengeView>(`/challenges/${enc(code)}`, { auth: 'optional' });
  }

  leaderboard(code: string, limit = 50): Promise<LeaderboardView> {
    return this.request<LeaderboardView>(`/challenges/${enc(code)}/leaderboard?limit=${limit}`, { auth: 'optional' });
  }

  /** Today's daily (`date` omitted) or a past day's. */
  daily(date?: string): Promise<ChallengeView> {
    return this.request<ChallengeView>(date ? `/daily/${enc(date)}` : '/daily', { auth: 'optional' });
  }

  /**
   * Generic call for modules that add endpoints (rooms, …): same auth, retry and error handling.
   * `auth` defaults to `required`.
   */
  call<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, options);
  }

  // --- plumbing ------------------------------------------------------------------------------

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? 'required';
    if (auth === 'required' && !this.getToken()) await this.createPlayer();
    try {
      return await this.raw<T>(path, options);
    } catch (err) {
      if (auth === 'required' && isApiError(err, 'auth')) {
        this.clearToken();
        await this.createPlayer();
        return this.raw<T>(path, options);
      }
      throw err;
    }
  }

  /** One HTTP exchange (plus one wait-and-retry for a short 429 on GET). */
  private async raw<T>(path: string, options: RequestOptions, retried = false): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = options.auth === 'none' ? null : this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body });
    } catch (err) {
      throw new ApiRequestError('network', 0, err instanceof Error ? err.message : String(err));
    }
    this.observeClock(res);
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      try {
        return (await res.json()) as T;
      } catch {
        throw new ApiRequestError('internal', res.status, 'response is not JSON');
      }
    }
    const error = await parseError(res);
    if (error.code === 'rate_limited' && method === 'GET' && !retried) {
      const wait = error.retryAfterS ?? 1;
      if (wait <= MAX_AUTO_RETRY_S) {
        await this.sleep(wait * 1000);
        return this.raw<T>(path, options, true);
      }
    }
    throw error;
  }

  /**
   * Track the server clock from the `Date` header (1 s resolution: the true server time lies in [D, D + 1 s)).
   * Offsets below a second are noise and ignored; local and server clocks usually agree.
   */
  private observeClock(res: Response): void {
    const header = res.headers?.get?.('date');
    if (!header) return;
    const server = Date.parse(header);
    if (!Number.isFinite(server)) return;
    const estimate = server + 500 - this.now();
    this.clockOffset = Math.abs(estimate) < 1000 ? 0 : estimate;
  }

  private emitPlayer(p: PlayerView): void {
    for (const fn of [...this.playerListeners]) fn(p);
  }

  private readToken(): string | null {
    try {
      return this.storage?.getItem(TOKEN_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private setToken(token: string): void {
    this.token = token;
    try {
      this.storage?.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable: the in-memory token lasts for this page */
    }
  }

  private clearToken(): void {
    this.token = null;
    try {
      this.storage?.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let code: ClientErrorCode = res.status >= 500 ? 'internal' : 'bad_request';
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string' && ERROR_CODES.includes(body.error)) code = body.error as ApiErrorCode;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    if (res.status === 401) code = 'auth';
    else if (res.status === 404) code = 'not_found';
    else if (res.status === 429) code = 'rate_limited';
  }
  const retry = Number(res.headers?.get?.('retry-after'));
  return new ApiRequestError(code, res.status, message, Number.isFinite(retry) && retry > 0 ? retry : null);
}

function enc(part: string): string {
  return encodeURIComponent(part);
}
