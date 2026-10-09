import { describe, expect, it } from 'vitest';
import { ApiClient, ApiRequestError, TOKEN_KEY, isApiError } from '../src/net/api';

/** In-memory localStorage. */
function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

type Handler = (call: Call, n: number) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.Authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const PLAYER = { id: 'p1', nickname: 'Wanderer1234', banned: false, createdAt: 1 };

describe('ApiClient identity', () => {
  it('creates a player first when there is no token, stores it and sends it as Bearer', async () => {
    const storage = memoryStorage();
    const { fetch, calls } = mockFetch((c) => {
      if (c.url === '/api/players') return json({ token: 'tok-1', player: PLAYER }, 201);
      return json(PLAYER);
    });
    const api = new ApiClient({ fetch, storage });
    const seen: string[] = [];
    api.onPlayer((p) => seen.push(p.nickname));
    const me = await api.me();
    expect(me.nickname).toBe('Wanderer1234');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/players', 'GET /api/me']);
    expect(calls[0]!.auth).toBeNull();
    expect(calls[1]!.auth).toBe('Bearer tok-1');
    expect(storage.data.get(TOKEN_KEY)).toBe('tok-1');
    expect(seen).toEqual(['Wanderer1234', 'Wanderer1234']);
  });

  it('on 401 auth creates a new player and retries once', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'stale' });
    const { fetch, calls } = mockFetch((c) => {
      if (c.url === '/api/players') return json({ token: 'fresh', player: PLAYER }, 201);
      return c.auth === 'Bearer fresh' ? json(PLAYER) : json({ error: 'auth' }, 401);
    });
    const api = new ApiClient({ fetch, storage });
    await api.me();
    expect(calls.map((c) => c.auth)).toEqual(['Bearer stale', null, 'Bearer fresh']);
    expect(api.getToken()).toBe('fresh');
  });

  it('a second 401 after the retry is an error, not a loop', async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === '/api/players' ? json({ token: 't', player: PLAYER }, 201) : json({ error: 'auth' }, 401),
    );
    const api = new ApiClient({ fetch, storage: memoryStorage({ [TOKEN_KEY]: 'x' }) });
    await expect(api.me()).rejects.toMatchObject({ code: 'auth', status: 401 });
    expect(calls).toHaveLength(3);
  });

  it('concurrent calls share one player creation', async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === '/api/players' ? json({ token: 't', player: PLAYER }, 201) : json(PLAYER),
    );
    const api = new ApiClient({ fetch, storage: memoryStorage() });
    await Promise.all([api.me(), api.me(), api.me()]);
    expect(calls.filter((c) => c.url === '/api/players')).toHaveLength(1);
  });

  it('optional-auth calls never create a player', async () => {
    const { fetch, calls } = mockFetch(() => json({ code: 'daily-2026-10-07' }));
    const api = new ApiClient({ fetch, storage: memoryStorage() });
    await api.daily();
    await api.challenge('abc');
    await api.leaderboard('abc', 10);
    expect(calls.map((c) => c.url)).toEqual(['/api/daily', '/api/challenges/abc', '/api/challenges/abc/leaderboard?limit=10']);
    expect(calls.every((c) => c.auth === null)).toBe(true);
  });

  it('works without storage (token kept in memory)', async () => {
    const { fetch, calls } = mockFetch((c) =>
      c.url === '/api/players' ? json({ token: 'mem', player: PLAYER }, 201) : json(PLAYER),
    );
    const api = new ApiClient({ fetch, storage: null });
    await api.me();
    await api.me();
    expect(calls.filter((c) => c.url === '/api/players')).toHaveLength(1);
    expect(calls[2]!.auth).toBe('Bearer mem');
  });
});

describe('ApiClient endpoints and errors', () => {
  const tokenStorage = (): Storage => memoryStorage({ [TOKEN_KEY]: 'tok' });

  it('sends the documented requests', async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const api = new ApiClient({ fetch, storage: tokenStorage() });
    await api.createGame({ kind: 'challenge', code: 'k1' });
    await api.getGame('g/1');
    await api.openRound('g1');
    await api.getNode('g1', 'abcdef123456');
    await api.guess('g1', { world: 'valley', x: 1, z: 2 });
    await api.guess('g1', null);
    await api.summary('g1');
    await api.updateNickname('Xardas');
    await api.daily('2026-10-01');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/games',
      'GET /api/games/g%2F1',
      'POST /api/games/g1/rounds',
      'GET /api/games/g1/nodes/abcdef123456',
      'POST /api/games/g1/guess',
      'POST /api/games/g1/guess',
      'GET /api/games/g1/summary',
      'PATCH /api/me',
      'GET /api/daily/2026-10-01',
    ]);
    expect(calls[0]!.body).toEqual({ kind: 'challenge', code: 'k1' });
    expect(calls[4]!.body).toEqual({ guess: { world: 'valley', x: 1, z: 2 } });
    expect(calls[5]!.body).toEqual({ guess: null });
    expect(calls[7]!.body).toEqual({ nickname: 'Xardas' });
  });

  it('maps error bodies to ApiRequestError codes', async () => {
    const { fetch } = mockFetch(() => json({ error: 'already_played', message: 'x' }, 409));
    const api = new ApiClient({ fetch, storage: tokenStorage() });
    const err = await api.createGame({ kind: 'daily' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(isApiError(err, 'already_played')).toBe(true);
    expect(isApiError(err, 'conflict')).toBe(false);
    expect((err as ApiRequestError).status).toBe(409);
  });

  it('unknown or missing error codes fall back by status', async () => {
    const { fetch } = mockFetch((_c, n) => (n === 1 ? json({ error: 'weird' }, 500) : new Response('nope', { status: 404 })));
    const api = new ApiClient({ fetch, storage: tokenStorage() });
    await expect(api.getGame('a')).rejects.toMatchObject({ code: 'internal' });
    await expect(api.getGame('b')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a transport failure is code network', async () => {
    const fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;
    const api = new ApiClient({ fetch, storage: tokenStorage() });
    await expect(api.getGame('a')).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('waits out a short 429 on GET once, but not on POST', async () => {
    const slept: number[] = [];
    let nodeCalls = 0;
    const { fetch } = mockFetch((c) => {
      if (c.url.includes('/nodes/')) {
        nodeCalls++;
        return nodeCalls === 1 ? json({ error: 'rate_limited' }, 429, { 'Retry-After': '1' }) : json({ key: 'k', links: [] });
      }
      return json({ error: 'rate_limited' }, 429, { 'Retry-After': '1' });
    });
    const api = new ApiClient({ fetch, storage: tokenStorage(), sleep: async (ms) => void slept.push(ms) });
    await expect(api.getNode('g', 'k')).resolves.toEqual({ key: 'k', links: [] });
    expect(slept).toEqual([1000]);
    await expect(api.guess('g', null)).rejects.toMatchObject({ code: 'rate_limited', retryAfterS: 1 });
  });

  it('estimates the server clock from the Date header, ignoring sub-second noise', async () => {
    let local = Date.parse('2026-10-07T12:00:00.300Z');
    let serverDate = 'Wed, 07 Oct 2026 12:00:00 GMT';
    const { fetch } = mockFetch(() => json({}, 200, { Date: serverDate }));
    const api = new ApiClient({ fetch, storage: tokenStorage(), now: () => local });
    await api.getGame('a');
    expect(api.serverNow()).toBe(local);
    serverDate = 'Wed, 07 Oct 2026 12:01:00 GMT'; // server a minute ahead
    await api.getGame('a');
    expect(api.serverNow() - local).toBe(60_200);
    local += 1000;
    expect(api.serverNow()).toBe(local + 60_200);
  });
});
